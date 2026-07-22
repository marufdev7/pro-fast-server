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
        const parcelsCollection = db.collection('parcels'); // parcels collection
        const paymentsCollection = db.collection('payments'); // payments collection
        const ridersCollection = db.collection('riders'); // riders collection
        const riderEarningsCollection = db.collection('riderEarnings'); // rider earnings collection
        const riderWalletCollection = db.collection('riderWallet'); // rider wallet collection
        const cashoutCollection = db.collection('cashout'); // cashout requests collection
        const trackingsCollection = db.collection('tracking') // tracking collection

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

        // parcel tracking log
        const trackingLog = async (tracking_id, parcelId, status) => {
            const log = {
                tracking_id,
                parcelId: parcelId ? parcelId.toString() : undefined,
                status,
                message: status.split('-').join(' '), // convert status to message
                created_at: new Date().toLocaleString(),
                // updated_by,
            };

            const result = await trackingsCollection.insertOne(log);
            return result;
        }

        // verify rider role
        const verifyRider = async (req, res, next) => {
            const email = req.decoded.email;
            const query = { email };
            try {
                const user = await usersCollection.findOne(query);
                if (!user || user.role !== 'rider') {
                    return res.status(403).send({ message: 'Forbidden Access - Riders only' });
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
                    .find({
                        $or: [
                            { email: { $regex: regex } },
                            // { name: { $regex: regex } } // add name search
                        ]
                    })
                    .project({
                        email: 1,
                        // name: 1,  // include name in projection
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
                const { email, last_log_in } = req.body;
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
            const result = await parcelsCollection
                .find(query)
                .sort({ _id: -1 }) // latest first
                .toArray();

            res.send(result);
        });

        //get parcel by id
        app.get('/parcels/:id', verifyFBToken, async (req, res) => {
            try {
                const id = req.params.id;

                const result = await parcelsCollection.findOne({
                    _id: new ObjectId(id),
                });

                res.status(201).send(result);
            } catch (error) {
                res.status(500).send({ message: 'Failed to get parcel' });
            }
        });

        // get rider assigned parcels
        app.get("/riders/parcels", verifyFBToken, verifyRider, async (req, res) => {
            try {
                const email = req.decoded.email;

                const rider = await ridersCollection.findOne({ email });

                if (!rider) {
                    return res.status(404).send({ message: "Rider profile not found" });
                }

                const parcels = await parcelsCollection.find({
                    assigned_rider_id: rider._id,
                    parcel_status: { $in: ["rider-assigned", "in-transit"] },
                })
                    .sort({ assigned_at: -1 })
                    .toArray();

                res.send(parcels);
            } catch (error) {
                res.status(500).send({ message: "Failed to load rider parcels" });
            }
        });

        // load complete parcels delivered for a rider
        app.get("/riders/completed-deliveries", verifyFBToken, verifyRider, async (req, res) => {
            try {
                const email = req.decoded.email;

                const rider = await ridersCollection.findOne({ email });

                if (!rider) {
                    return res.status(404).send({ message: "Rider profile not found" });
                }

                const parcels = await parcelsCollection
                    .find({
                        assigned_rider_id: new ObjectId(rider._id),
                        parcel_status: { $in: ["delivered", "service-center-delivered"] },
                    })
                    .sort({ delivered_at: -1 })
                    .toArray();

                // Earning structure
                const EARNING_RULES = {
                    SAME_REGION: 0.3,    // 30%
                    CROSS_REGION: 0.15,  // 15%
                };
                let totalEarning = 0;

                const deliveries = parcels.map((parcel) => {
                    let earning = 0;

                    if (parcel.senderWarehouse === parcel.receiverWarehouse) {
                        earning = parcel.cost * EARNING_RULES.SAME_REGION;
                    } else {
                        earning = parcel.cost * EARNING_RULES.CROSS_REGION;
                    }

                    totalEarning += earning;

                    return {
                        _id: parcel._id,
                        tracking_id: parcel.tracking_id,
                        cost: parcel.cost,
                        title: parcel.title,
                        senderWarehouse: parcel.senderWarehouse,
                        receiverWarehouse: parcel.receiverWarehouse,
                        picked_up_at: parcel.picked_up_at || null,
                        delivered_at: parcel.delivered_at || null,
                        earning: Math.round(earning),
                        deliveryType: parcel.senderWarehouse === parcel.receiverWarehouse ? "Same Region" : "Cross Region",
                    };
                });

                res.send({
                    totalEarning: Math.round(totalEarning),
                    deliveries,
                });
            } catch (error) {
                console.error("Completed deliveries error:", error);
                res.status(500).send({ message: "Failed to load completed deliveries" });
            }
        });

        // rider cashout request
        app.post("/riders/cashout", verifyFBToken, verifyRider, async (req, res) => {
            try {
                const email = req.decoded.email;
                const { amount } = req.body;

                const MIN_CASHOUT_AMOUNT = 100;

                // Validate amount - must be positive integer
                if (!Number.isInteger(amount) || amount <= 0) {
                    return res.status(400).send({
                        message: "Amount must be a positive integer",
                    });
                }

                if (amount < MIN_CASHOUT_AMOUNT) {
                    return res.status(400).send({
                        message: `Minimum cashout amount is ${MIN_CASHOUT_AMOUNT}`,
                    });
                }

                // Check rider's wallet balance
                let wallet = await riderWalletCollection.findOne({ riderEmail: email });

                // If wallet doesn't exist, create one
                if (!wallet) {
                    return res.status(400).send({
                        message: "No wallet found. You need to complete at least one delivery to earn money.",
                    });
                }

                if (wallet.availableBalance < amount) {
                    return res.status(400).send({
                        message: `Insufficient balance. Available: ${wallet.availableBalance}, Requested: ${amount}`,
                    });
                }

                // Create cashout request
                const cashout = {
                    riderEmail: email,
                    amount,
                    status: "pending",
                    requested_at: new Date().toLocaleString(),
                };

                const cashoutResult = await cashoutCollection.insertOne(cashout);

                // Deduct from available balance
                await riderWalletCollection.updateOne(
                    { riderEmail: email },
                    {
                        $inc: {
                            availableBalance: -amount,
                            pendingWithdrawal: amount,
                        },
                        $set: { updated_at: new Date().toLocaleString() },
                    }
                );

                // Mark earnings as pending_cash out
                await riderEarningsCollection.updateMany(
                    { riderEmail: email, status: "available" },
                    {
                        $set: { status: "pending_cashout" }
                    },
                    { upsert: false }
                );

                console.log(`Cash out request created for ${email}: ${amount}`);
                res.send({
                    message: "Cash out request submitted",
                    cashoutId: cashoutResult.insertedId,
                    amount,
                });
            } catch (error) {
                console.error("Cash out error:", error);
                res.status(500).send({ message: "Cash out failed" });
            }
        });

        // Add a new parcel
        app.post('/parcels', verifyFBToken, async (req, res) => {
            try {
                const parcelData = req.body;

                const result = await parcelsCollection.insertOne(parcelData);
                await trackingLog(
                    parcelData.tracking_id,
                    result.insertedId,
                    parcelData.parcel_status || 'pending'
                );
                res.status(201).send(result);
            } catch (err) {
                console.error('Error adding parcel:', err);
                res.status(500).send({ message: 'Failed to add parcel' });
            }
        });

        // Assign a rider to a parcel
        app.patch('/parcels/:id/assign-rider', verifyFBToken, verifyAdmin, async (req, res) => {
            try {
                const { riderId, riderName, tracking_id } = req.body;
                const parcelId = req.params.id;

                if (!parcelId || !riderId) {
                    return res.status(400).send({ message: "Missing parcel or rider" });
                }

                // 1. Update parcel
                const parcelResult = await parcelsCollection.updateOne(
                    { _id: new ObjectId(parcelId) },
                    {
                        $set: {
                            parcel_status: "rider-assigned",
                            assigned_rider_id: new ObjectId(riderId),
                            assigned_rider_name: riderName,
                            assigned_at: new Date().toLocaleString(),
                        }
                    }
                );

                // 2. Update rider
                const riderResult = await ridersCollection.updateOne(
                    { _id: new ObjectId(riderId) },
                    {
                        $set: {
                            working_status: "in-delivery"
                        }
                    }
                );

                if (!parcelResult.modifiedCount || !riderResult.modifiedCount) {
                    return res.status(400).send({ message: "Assignment failed" });
                }

                // add tracking log
                trackingLog(tracking_id, parcelId, "rider-assigned");

                res.send({ message: "Rider assigned successfully" });
            } catch (error) {
                res.status(500).send({ message: "Server error" });
            }
        });

        // Pickup a parcel
        app.patch("/parcels/:id/pickup", verifyFBToken, verifyRider, async (req, res) => {
            try {
                const { id } = req.params;
                const { tracking_id } = req.body;

                const result = await parcelsCollection.updateOne(
                    {
                        _id: new ObjectId(id),
                        parcel_status: "rider-assigned",
                    },
                    {
                        $set: {
                            parcel_status: "in-transit",
                            picked_up_at: new Date().toLocaleString(),
                        },
                    }
                );

                if (result.matchedCount === 0) {
                    return res
                        .status(400)
                        .send({ message: "Parcel not eligible for pickup" });
                }

                // add tracking log
                trackingLog(tracking_id, id, "in-transit");

                res.send({ message: "Parcel picked up successfully" });
            } catch (error) {
                res.status(500).send({ message: "Failed to pickup parcel" });
            }
        });

        // Delivered a parcel
        app.patch("/parcels/:id/deliver", verifyFBToken, verifyRider, async (req, res) => {
            try {
                const riderEmail = req.decoded.email;
                const { id } = req.params;
                const { tracking_id } = req.body;

                // Get parcel details first
                const parcel = await parcelsCollection.findOne({
                    _id: new ObjectId(id),
                    parcel_status: "in-transit",
                });

                if (!parcel) {
                    return res.status(400).send({ message: "Parcel not eligible for delivery" });
                }

                // Calculate earning based on warehouse location
                const EARNING_RULES = {
                    SAME_REGION: 0.3,
                    CROSS_REGION: 0.15,
                };
                let earning = 0;

                if (parcel.senderWarehouse === parcel.receiverWarehouse) {
                    earning = parcel.cost * EARNING_RULES.SAME_REGION;
                } else {
                    earning = parcel.cost * EARNING_RULES.CROSS_REGION;
                }

                const roundedEarning = Math.round(earning);

                // Update parcel status
                const updateResult = await parcelsCollection.updateOne(
                    {
                        _id: new ObjectId(id),
                        parcel_status: "in-transit",
                    },
                    {
                        $set: {
                            parcel_status: "delivered",
                            delivered_at: new Date().toLocaleString(),
                        },
                    }
                );

                if (updateResult.matchedCount === 0) {
                    return res.status(400).send({ message: "Parcel not eligible for delivery" });
                }

                // add tracking log
                trackingLog(tracking_id, id, "delivered");

                // Record earning
                if (roundedEarning > 0) {
                    await riderEarningsCollection.insertOne({
                        riderEmail,
                        parcelId: parcel._id,
                        amount: roundedEarning,
                        deliveryType: parcel.senderWarehouse === parcel.receiverWarehouse ? "Same Region" : "Cross Region",
                        status: "available",
                        created_at: new Date().toLocaleString(),
                    });

                    // Update wallet
                    await riderWalletCollection.updateOne(
                        { riderEmail },
                        {
                            $inc: {
                                totalEarned: roundedEarning,
                                availableBalance: roundedEarning,
                            },
                            $set: { updated_at: new Date().toLocaleString() },
                        },
                        { upsert: true }
                    );
                }

                // Update rider status to "available"
                await ridersCollection.updateOne(
                    { _id: parcel.assigned_rider_id },
                    {
                        $set: {
                            working_status: "available",
                        }
                    }
                );

                console.log(`Delivery completed: Parcel ${id}, Earnings: ${roundedEarning}`);
                res.send({
                    message: "Parcel delivered successfully & earning recorded",
                    earning: roundedEarning,
                });
            } catch (error) {
                console.error("Delivery error:", error);
                res.status(500).send({ message: "Failed to deliver parcel" });
            }
        });

        // Delete a parcel by ID
        app.delete('/parcels/:id', verifyFBToken, async (req, res) => {
            try {
                const id = req.params.id;

                const result = await parcelsCollection.deleteOne({
                    _id: new ObjectId(id),
                });

                res.send(result);
            } catch (error) {
                res.status(500).send({ message: 'Failed to delete parcel' });
            }
        });

        // riders api

        // insert rider
        app.post('/riders', verifyFBToken, async (req, res) => {
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
        app.get('/riders/available', verifyFBToken, async (req, res) => {
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
                res.status(500).send({ message: 'Failed to load available riders' });
            }
        });

        // update rider status
        app.patch('/riders/:id', verifyFBToken, verifyAdmin, async (req, res) => {
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
        app.post('/payments', verifyFBToken, async (req, res) => {
            try {
                const { parcelId, email, amount, paymentMethod, transactionId } = req.body;

                // Update parcel payment status
                const updateResult = await parcelsCollection.updateOne(
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
        app.post('/create-payment-intent', verifyFBToken, async (req, res) => {
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
