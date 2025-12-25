const express = require('express');
const app = express();
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const admin = require("firebase-admin");
const port = process.env.PORT || 5000;

// .env file config
require('dotenv').config();
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);


// middleware
app.use(cors());
app.use(express.json());


const serviceAccount = require("./firebase-admin-key.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.jworznu.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();

        const db = client.db('proFastDB'); // database
        const userCollection = db.collection('users') // user collection
        const parcelCollection = db.collection('parcels'); // parcels collection
        const paymentsCollection = db.collection('payments'); // payments collection
        // const trackingCollection = db.collection('tracking') // tracking collection

        // custom middlewares
        const verifyFBToken = async (req, res, next) => {
            const authHeader = req.headers.authorization;
            if (!authHeader) {
                res.status(401).send({ message: 'Unauthorized Access' });
            }

            const token = authHeader.split(' ')[1];
            if (!token) {
                res.status(401).send({ message: 'Unauthorized Access' });
            }

            // verify token
            try {
                const decoded = await admin.auth().verifyIdToken(token);
                req.decoded = decoded;
                next();
            }
            catch (error) {
                return res.status(403).send({ message: 'Forbidden Access' })
            }
        }

        // users api
        app.post('/users', async (req, res) => {
            try {
                const email = req.body.email;
                const existingUser = await userCollection.findOne({ email });
                if (existingUser) {

                    //update Last login
                    const updateLoginTime = await userCollection.updateOne(
                        { email },
                        {
                            $set: {
                                last_log_in: req.body.last_log_in,
                            },
                        }
                    )
                    return res.status(200).send({ message: 'User already exists', inserted: false });
                }

                const user = req.body;
                const result = await userCollection.insertOne(user);
                res.status(201).send(result);

            } catch (error) {
                res.status(500).send({ message: 'Failed to add a user' });
            }
        })

        // parcels api
        app.get('/parcels', verifyFBToken, async (req, res) => {
            const email = req.query.email;

            const query = email ? { created_by: email } : {};

            const result = await parcelCollection
                .find(query)
                .sort({ _id: -1 }) // latest first
                .toArray();

            res.send(result);
        });

        //get parcel by id
        app.get('/parcels/:id', async (req, res) => {
            try {
                const id = req.params.id;

                const result = await parcelCollection.findOne({
                    _id: new ObjectId(id),
                });

                res.status(201).send(result);
            } catch (error) {
                res.status(500).send({ message: 'Failed to get parcel' });
            }
        });

        // Add a new parcel
        app.post('/parcels', async (req, res) => {
            try {
                const parcelData = req.body;

                const result = await parcelCollection.insertOne(parcelData);
                res.status(201).send(result);
            } catch (err) {
                console.error('Error adding parcel:', err);
                res.status(500).send({ message: 'Failed to add parcel' });
            }
        });

        // Delete a parcel by ID
        app.delete('/parcels/:id', async (req, res) => {
            try {
                const id = req.params.id;

                const result = await parcelCollection.deleteOne({
                    _id: new ObjectId(id),
                });

                res.send(result);
            } catch (error) {
                res.status(500).send({ message: 'Failed to delete parcel' });
            }
        });

        // // parcel tracking
        // app.post('/tracking', async (req, res) => {
        //     try {
        //         const { tracking_id, parcelId, message, status, updated_by = '' } = req.body;

        //         const trackingLog = {
        //             tracking_id,
        //             parcelId: parcelId ? new ObjectId(parcelId) : undefined,
        //             message,
        //             status,
        //             time: new Date(),
        //             updated_by,
        //         };

        //         const result = await trackingCollection.insertOne(trackingLog);
        //         res.status(201).send(result)
        //     } catch (error) {
        //         res.status(500).send({ message: "Failed to add tracking update" });
        //     }
        // })

        // get payment history by email
        app.get("/payments", verifyFBToken, async (req, res) => {
            try {
                const { email } = req.query;

                if (!email) {
                    return res.status(400).send({ message: "Email is required" });
                }

                // console.log('decoded', req.decoded);
                if (req.decoded.email !== email) {
                    return res.status(403).send({ message: 'Forbidden Access' })
                }

                const payments = await paymentsCollection
                    .find({ userEmail: email })
                    .sort({ paid_at: -1 })
                    .toArray();

                res.send(payments);
            } catch (error) {
                console.error("Failed to load payments:", error);
                res.status(500).send({ message: "Failed to load payment history" });
            }
        });

        // payment history and update parcel status
        app.post('/payments', async (req, res) => {
            try {
                const { parcelId, email, amount, paymentMethod, transactionId } = req.body;

                // Update parcel payment status
                const updateResult = await parcelCollection.updateOne(
                    { _id: new ObjectId(parcelId) },
                    {
                        $set: {
                            payment_status: 'Paid',
                        }
                    }

                );

                if (updateResult.modifiedCount === 0) {
                    return res.status(404).send({ message: 'Parcel not found or already paid' });
                }

                // payment history
                const paymentRecord = {
                    parcelId,
                    userEmail: email,
                    amount,
                    paymentMethod,
                    transactionId,
                    paid_at_string: new Date().toLocaleString(),
                    paid_at: new Date(),
                };
                const paymentResult = await paymentsCollection.insertOne(paymentRecord);
                res.status(201).send({
                    message: 'Payment recorded and parcel marked as paid',
                    insertedId: paymentResult.insertedId,
                });
            } catch (error) {
                console.error('Payment processing failed:', error);
                res.status(500).send({ message: 'Failed to process payment' });
            }
        });

        // create payment intent
        app.post('/create-payment-intent', async (req, res) => {
            try {
                const amount = req.body.amount;
                const paymentIntent = await stripe.paymentIntents.create({
                    amount: amount, // cents
                    currency: "usd",
                    payment_method_types: ["card"],
                });
                res.json({ clientSecret: paymentIntent.client_secret });
            }
            catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);


app.get('/', (req, res) => {
    res.send("ProFast Server is Running");
});

app.listen(port, () => {
    console.log(`ProFast Running on port ${port}`);
})