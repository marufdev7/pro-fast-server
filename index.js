const express = require('express');
const app = express();
const cors = require('cors');
require('dotenv').config();
const { MongoClient, ServerApiVersion } = require('mongodb');
const port = process.env.PORT || 5000;

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