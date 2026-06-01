const express = require("express");

const dns = require("dns");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const crypto = require("crypto");

const generateTrackingId = () => {
  const prefix = "WS";
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const random = crypto.randomBytes(4).toString("hex").toUpperCase();

  return `${prefix}-${date}-${random}`;
};

const admin = require("firebase-admin");
const serviceAccount = require("./adminKey.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "Unauthorized Access" });
  }
};

require("dotenv").config();
const app = express();
app.use(express.json());
app.use(cors());
const port = process.env.PORT || 3000;
dns.setServers(["1.1.1.1", "8.8.8.8"]);
const uri =
  "mongodb+srv://weshift:bakugan@cluster0.l1vdkel.mongodb.net/?appName=Cluster0";
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("weshift-db");
    const parcelCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const userCollection = db.collection("users");
    const RiderCollection = db.collection("riders");
    await paymentCollection.createIndex({ transactionId: 1 }, { unique: true });

    app.get("/parcels", verifyToken, async (req, res) => {
      const email = req.query.email;
      // console.log(req.query.email);
      const query = {};
      if (email) {
        query.senderEmail = email;
        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "Forbidden Access" });
        }
      }
      console.log(query);
      const result = await parcelCollection.find(query).toArray();
      // console.log({ data: result });

      res.json({ data: result });
    });

    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      // console.log(parcel);
      const result = await parcelCollection.insertOne(parcel);
      res.json({ result, message: "Parcel Sent Succesfully" });
    });
    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;

      const result = await parcelCollection.findOne({
        _id: new ObjectId(id),
      });
      // console.log(result);

      res.json(result);
    });

    //payment
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      // console.log(paymetnInfo, "paymentinto");
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "BDT",
              product_data: {
                name: paymentInfo.parcelName,
              },
              unit_amount: paymentInfo.cost * 100,
            },

            quantity: 1,
          },
        ],
        customer_email: paymentInfo.senderEmail,
        mode: "payment",
        metadata: {
          parcel_id: paymentInfo.parcel_id,
          parcelName: paymentInfo.parcelName,
        },
        success_url: `http://localhost:5174/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `http://localhost:5174/dashboard/payment-cancelled`,
      });
      res.send({ url: session.url });
    });

    app.patch("/payment-success", async (req, res) => {
      const session_id = req.query.session_id;
      console.log(session_id);

      const trackingId = generateTrackingId();
      const session = await stripe.checkout.sessions.retrieve(session_id);
      const transactionId = session.payment_intent;
      query = { transactionId: transactionId };
      const isExist = await paymentCollection.findOne(query);
      if (isExist) {
        return res.json({
          success: true,
          message: "Payment already recorded",
          trackingId: isExist.trackingId,
          transactionId: isExist.transactionId,
        });
      }

      if (session.payment_status === "paid") {
        const id = session.metadata.parcel_id;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            paymentStatus: "paid",
            trackingId: trackingId,
          },
        };
        const result = await parcelCollection.updateOne(query, update);

        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: session.metadata.parcel_id,
          parcelName: session.metadata.parcelName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          trackingId: trackingId,
          paidAt: new Date(),
        };

        if (session.payment_status === "paid") {
          const resultPayment = await paymentCollection.insertOne(payment);

          res.json({
            success: true,
            paymentInfo: resultPayment,
            trackingId: trackingId,
            updateInfo: result,
            transactionId: payment.transactionId,
          });
        }
      }
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date();
      const userExist = await userCollection.findOne({ email });
      if (userExist) {
        res.send({ message: "User Already Added" });
      }
      const result = await userCollection.insertOne(user);
      res.send(result);
    });
    app.post("/riders", async (req, res) => {
      const rider = req.body;
      rider.status = "pending";
      const email = req.body.email;
      rider.createdAt = new Date();
      const userExist = await RiderCollection.findOne({ email });
      if (userExist) {
        res.send({ message: "Rider Already Added" });
      }
      const result = await RiderCollection.insertOne(rider);
      res.send(result);
    });

    app.get("/riders", async (req, res) => {
      const query = {};
      if (req.query.status) {
        query.status = req.query.status;
      }
      const result = await RiderCollection.find(query).toArray();
      res.send(result);
    });

    app.patch("/riders/:id", async (req, res) => {
      const status = req.body.status;
      const query = { _id: new ObjectId(req.params.id) };
      const update = {
        $set: {
          status: status,
        },
      };
      const result = await RiderCollection.updateOne(query, update);
      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.json("We are shifting");
});

app.listen(port, () => {
  console.log(`We are Shifting to port ${port}`);
});
