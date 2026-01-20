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
        const usersCollection = db.collection('users') // user collection
        const parcelCollection = db.collection('parcels'); // parcels collection
        const paymentsCollection = db.collection('payments'); // payments collection
        const ridersCollection = db.collection('riders'); // riders collection
        // const trackingCollection = db.collection('tracking') // tracking collection

        // custom middlewares
        // verify firebase token and authorized access
        const verifyFBToken = async (req, res, next) => {
            const authHeader = req.headers.authorization;
            if (!authHeader) {
                return res.status(401).send({ message: 'Unauthorized Access' });
            }

            const token = authHeader.split(' ')[1];
            if (!token) {
                return res.status(401).send({ message: 'Unauthorized Access' });
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

        // verify admin role
        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded.email;
            const query = { email };
            try {
                const user = await usersCollection.findOne(query);
                if (!user || user.role !== 'admin') {
                    return res.status(403).send({ message: 'Forbidden Access - Admins only' });
                }
                next();
            }
            catch (error) {
                return res.status(403).send({ message: 'Forbidden Access' })
            }
        }

        // get user by search
        app.get('/users/search', async (req, res) => {
            const emailQuery = req.query.email;

            if (!emailQuery) {
                return res.status(400).send({ message: "Email query is required" });
            }

            const regex = new RegExp(emailQuery, "i"); // case insensitive partial search

            try {
                const users = await usersCollection
                    .find({ email: { $regex: regex } })
                    .project({
                        email: 1,
                        created_at: 1,
                        role: 1
                    })
                    .limit(10)
                    .toArray();

                res.send(users);
            } catch (error) {
                console.error("User search error:", error);
                res.status(500).send({ message: "Failed to search users" });
            }
        });

        // get user by role
        app.get('/users/:email/role', async (req, res) => {
            try {
                const email = req.params.email;

                if (!email) {
                    return res.status(400).send({ message: 'Email is required' });
                }

                const user = await usersCollection.findOne({ email });

                if (!user) {
                    return res.status(404).send({ message: 'User not found' });
                }

                res.send({ role: user.role || 'user' });
            } catch (error) {
                res.status(500).send({ message: 'Failed to get user role' });
            }
        });

        // users api
        app.post('/users', async (req, res) => {
            try {
                const email = req.body.email;
                const existingUser = await usersCollection.findOne({ email });
                if (existingUser) {

                    //update Last login
                    const updateLoginTime = await usersCollection.updateOne(
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
                const result = await usersCollection.insertOne(user);
                res.status(201).send(result);

            } catch (error) {
                res.status(500).send({ message: 'Failed to add a user' });
            }
        });

        // make and remove admin
        app.patch('/users/:id/role', verifyFBToken, verifyAdmin, async (req, res) => {
            const { id } = req.params;
            const { role } = req.body;

            if (!['admin', 'user'].includes(role)) {
                return res.status(400).send({ message: 'Invalid role' });
            }

            try {
                const result = await usersCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { role } }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).send({ message: 'User not found' });
                }

                res.send({
                    message: `User role updated to ${role}`,
                    modifiedCount: result.modifiedCount,
                });
            } catch (error) {
                console.error('Error updating user role:', error);
                res.status(500).send({ message: 'Failed to update user role' });
            }
        });

        // parcels api
        app.get('/parcels', verifyFBToken, async (req, res) => {
            const { email, payment_status, parcel_status } = req.query;

            let query = {};
            if (email) {
                query = { created_by: email }
            }

            if (payment_status) {
                query.payment_status = payment_status;
            }

            if (parcel_status) {
                query.parcel_status = parcel_status;
            }
            // console.log('parcel query', req.query, query);

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

        // riders api

        // insert rider
        app.post('/riders', async (req, res) => {
            const rider = req.body;
            const result = await ridersCollection.insertOne(rider);
            res.send(result);
        })

        // get riders in pending
        app.get('/riders/pending', verifyFBToken, verifyAdmin, async (req, res) => {
            try {
                const result = await ridersCollection.find({ status: 'pending' }).toArray();
                res.send(result);
            } catch (error) {
                res.status(500).send({ message: 'Failed to load pending riders' });
            }
        });

        // get active riders
        app.get('/riders/active', verifyFBToken, verifyAdmin, async (req, res) => {
            try {
                const result = await ridersCollection.find({ status: 'active' }).toArray();
                res.send(result);
            } catch (error) {
                res.status(500).send({ message: 'Failed to load active riders' });
            }
        });

        // get available riders by district
        app.get('/riders/available', async (req, res) => {
            const { district } = req.query;

            if (!district) {
                return res.status(400).send({ message: 'District is required' });
            }

            try {
                const riders = await ridersCollection.find({
                    district,
                    status: 'active',
                })
                    .toArray();

                res.send(riders);
            } catch (error) {
                console.error(error);
                res.status(500).send({ message: 'Failed to load available riders' });
            }
        });

        // update rider status
        app.patch('/riders/:id', async (req, res) => {
            try {
                const id = req.params.id;
                const { status, email } = req.body;

                const result = await ridersCollection.updateOne(
                    { _id: new ObjectId(id) },
                    {
                        $set: { status },
                    }
                );

                // update user role for accepting rider
                if (status === 'active') {
                    const userQuery = { email };
                    const userUpdateDoc = {
                        $set: {
                            role: 'rider'
                        }
                    };
                    const roleResult = await usersCollection.updateOne(userQuery, userUpdateDoc);
                }

                res.send(result);
            } catch (error) {
                res.status(500).send({ message: 'Failed to update rider status' });
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
                            payment_status: 'paid',
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