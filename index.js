const express = require('express');
const app = express();
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const port = process.env.PORT || 5000;

// .env file config
require('dotenv').config();
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);


// middleware
app.use(cors());
app.use(express.json());

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

        const db = client.db('proFastDB');
        const parcelCollection = db.collection('parcels');

        app.get('/parcels', async (req, res) => {
            const result = await parcelCollection.find().toArray();
            res.send(result);
        });

        // parcels api
        app.get('/parcels', async (req, res) => {
            const email = req.query.email;

            const query = email ? { email } : {};

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

                res.send(result);
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

        // create payment intent
        app.post('/create-payment-intent', async (req, res) => {
            try {
                // const amount = req.body.cost;
                const paymentIntent = await stripe.paymentIntents.create({
                    amount: amount , // cents
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