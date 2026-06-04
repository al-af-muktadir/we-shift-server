const express = require("express");
require("dotenv").config();
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
// const serviceAccount = require("./adminKey.json");
const decoded = Buffer.from(process.env.ADMIN_KEY, "base64").toString("utf8");
const serviceAccount = JSON.parse(decoded);
const { pipeline } = require("stream");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: ["http://localhost:5173", "https://weshare-fc36f.web.app"],
    credentials: true,
  }),
);
const port = process.env.PORT || 3000;
dns.setServers(["1.1.1.1", "8.8.8.8"]);
const uri = `mongodb+srv://${process.env.ID}:${process.env.PASS}@cluster0.l1vdkel.mongodb.net/?appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization;
  console.log("inmw", token);
  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    console.log(decoded);
    req.decoded_email = decoded.email;
    // console.log("inmW", decoded.email);
    next();
  } catch (err) {
    return res.status(401).send({ message: "Unauthorized Access" });
  }
};

const verifyAdmin = async (req, res, next) => {
  const email = req.decoded_email;
  const query = { email };
  const user = await userCollection.findOne(query);
  if (!user || user.role !== "admin") {
    return res.status(403).send({ message: "Forbidden Access" });
  }
  next();
};

const verifyRider = async (req, res, next) => {
  const email = req.decoded_email;
  const user = await userCollection.findOne({ email });

  if (!user || user.role !== "rider") {
    return res.status(403).send({ message: "Forbidden Access" });
  }

  next();
};
async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("weshift-db");
    const parcelCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const userCollection = db.collection("users");
    const RiderCollection = db.collection("riders");
    const trackingCollection = db.collection("tracking");
    await paymentCollection.createIndex({ transactionId: 1 }, { unique: true });

    const logTracking = async (trackingId, status) => {
      const log = {
        trackingId,
        status,
        details: status.split("_").join(" "),

        createdAt: new Date(),
      };
      const result = await trackingCollection.insertOne(log);
      return result;
    };

    app.get("/parcels", verifyToken, async (req, res) => {
      const email = req.query.email;
      const deliveryStatus = req.query.deliveryStatus;
      // console.log(req.query.email);
      const query = {};
      if (email) {
        query.senderEmail = email;
        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "Forbidden Access" });
        }
      }

      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
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

    app.get("/parcels/rider", async (req, res) => {
      const { riderEmail, deliveryStatus } = req.query;
      const query = {};
      if (riderEmail) {
        query.riderEmail = riderEmail;
      }
      // if (deliveryStatus) {
      //   query.deliveryStatus = deliveryStatus;
      // }
      console.log(query, "inriderparcel");
      const result = await parcelCollection.find(query).toArray();
      console.log(result);

      res.send(result);
    });

    app.get("/parcels/deliveryStatus/admin", async (req, res) => {
      const pipeline = [
        {
          $group: {
            _id: "$deliveryStatus",
            count: { $sum: 1 },
          },
        },
      ];

      const result = await parcelCollection.aggregate(pipeline).toArray();
      res.send(result);
    });

    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;

      const result = await parcelCollection.findOne({
        _id: new ObjectId(id),
      });
      // console.log(result);

      res.json(result);
    });

    app.patch(
      "/parcels/:id/reviewassign",
      verifyToken,
      verifyRider,
      async (req, res) => {
        const { deliveryStatus, trackingId } = req.body;
        const query = { _id: new ObjectId(req.params.id) };
        const updatedDoc = {
          $set: {
            deliveryStatus,
          },
        };
        const result = await parcelCollection.updateOne(query, updatedDoc);
        const parcel = await parcelCollection.findOne(query);
        if (
          parcel.riderEmail === req.decoded_email &&
          parcel.deliveryStatus === "delivered"
        ) {
          const update3 = {
            $set: {
              workingStatus: "available",
            },
          };
          const result2 = await RiderCollection.updateOne(
            { email: parcel.riderEmail },
            update3,
          );
        }
        logTracking(trackingId, deliveryStatus);
        res.send(result);
      },
    );

    app.patch("/parcels/:id", verifyToken, verifyAdmin, async (req, res) => {
      const { parcelId, riderId, riderName, riderEmail, trackingId } = req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const update = {
        $set: {
          deliveryStatus: "driver_assigned",
          riderId: riderId,
          riderName: riderName,
          riderEmail: riderEmail,
        },
      };

      const result = await parcelCollection.updateOne(query, update);

      logTracking(trackingId, "driver_assigned");

      const riderQuery = { _id: new ObjectId(riderId) };
      const update2 = {
        $set: {
          workingStatus: "in_delivery",
        },
      };

      const rr = await RiderCollection.updateOne(riderQuery, update2);
      res.send(rr);
    });

    //payment
    app.post("/create-checkout-session", verifyToken, async (req, res) => {
      try {
        const paymentInfo = req.body;

        console.log(paymentInfo, "paymentInfo");

        if (
          !paymentInfo?.cost ||
          !paymentInfo?.parcel_id ||
          !paymentInfo?.senderEmail ||
          !paymentInfo?.parcelName
        ) {
          return res.status(400).send({
            message: "Missing payment information",
            paymentInfo,
          });
        }

        const session = await stripe.checkout.sessions.create({
          line_items: [
            {
              price_data: {
                currency: "BDT",
                product_data: {
                  name: paymentInfo.parcelName,
                },
                unit_amount: Number(paymentInfo.cost) * 100,
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
          success_url:
            "https://weshare-fc36f.web.app/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}",
          cancel_url:
            "https://weshare-fc36f.web.app/dashboard/payment-cancelled",
        });

        res.send({ url: session.url });
      } catch (err) {
        console.error("Stripe checkout error:", err.message);

        res.status(400).send({
          message: err.message,
        });
      }
    });

    app.post("/payment-success", verifyToken, async (req, res) => {
      try {
        const session_id = req.query.session_id;

        if (!session_id) {
          return res.status(400).send({ message: "session_id is required" });
        }

        console.log("Payment success session_id:", session_id);

        const session = await stripe.checkout.sessions.retrieve(session_id);
        const transactionId = session.payment_intent;

        const existingPayment = await paymentCollection.findOne({
          transactionId,
        });

        if (existingPayment) {
          return res.json({
            success: true,
            message: "Payment already recorded",
            trackingId: existingPayment.trackingId,
            transactionId: existingPayment.transactionId,
          });
        }

        if (session.payment_status !== "paid") {
          return res.status(400).send({
            success: false,
            message: "Payment not completed",
            paymentStatus: session.payment_status,
          });
        }

        const trackingId = generateTrackingId();
        const parcelId = session.metadata.parcel_id;

        const updateResult = await parcelCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              paymentStatus: "paid",
              deliveryStatus: "pending_pickup",
              trackingId,
            },
          },
        );

        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId,
          parcelName: session.metadata.parcelName,
          transactionId,
          paymentStatus: session.payment_status,
          trackingId,
          paidAt: new Date(),
        };

        const resultPayment = await paymentCollection.insertOne(payment);

        await logTracking(trackingId, "pending_pickup");

        res.json({
          success: true,
          paymentInfo: resultPayment,
          trackingId,
          updateInfo: updateResult,
          transactionId,
        });
      } catch (err) {
        console.error("Payment success error:", err.message);

        res.status(500).send({
          success: false,
          message: err.message,
        });
      }
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      console.log(req.body, "in useruser");
      user.role = "user";
      user.createdAt = new Date();
      const userExist = await userCollection.findOne({ email: req.body.email });
      if (userExist) {
        res.send({ message: "User Already Added" });
      } else {
        const result = await userCollection.insertOne(user);
        res.send(result);
      }
    });

    app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
      const search = req.query.searchText;
      const query = {};
      if (search) {
        query.$or = [
          { displayName: { $regex: search, $options: "i" } },
          { email: { $regex: search, $options: "i" } },
        ];
      }
      const result = await userCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();
      res.send(result);
    });

    app.post("/riders", verifyToken, async (req, res) => {
      const rider = req.body;
      rider.status = "pending";
      const email = req.body.email;
      rider.createdAt = new Date();
      const userExist = await RiderCollection.findOne({ email });
      if (userExist) {
        return res.send({ message: "Rider Already Added" });
      }
      const isAdmin = await userCollection.findOne({ email });
      console.log("Admin", isAdmin);
      if (isAdmin.role === "admin") {
        return res.send({ message: "Admin Cannot be a Rider" }).status(403);
      } else {
        const result = await RiderCollection.insertOne(rider);
        const update = {
          $set: {
            role: "rider",
          },
        };

        const result2 = await userCollection.updateOne({ email }, update);
        res.send(result);
      }
    });

    app.get("/riders", verifyToken, verifyAdmin, async (req, res) => {
      const query = {};
      if (req.query.status) {
        query.status = req.query.status;
      }
      if (req.query.workingStatus) {
        query.workingStatus = req.query.workingStatus;
      }
      if (req.query.district) {
        query.district = req.query.district;
      }

      console.log(query, "hahahha");
      const result = await RiderCollection.find(query).toArray();
      res.send(result, "hahah");
    });

    app.patch("/riders/:id", verifyToken, verifyAdmin, async (req, res) => {
      const session = client.startSession();

      try {
        const status = req.body.status;
        const email = req.body.email;

        const riderQuery = { _id: new ObjectId(req.params.id) };
        const userQuery = { email };

        let riderUpdateResult;
        let userUpdateResult;

        await session.withTransaction(async () => {
          riderUpdateResult = await RiderCollection.updateOne(
            riderQuery,
            {
              $set: { status, workingStatus: "available" },
            },
            { session },
          );

          if (status === "approved") {
            userUpdateResult = await userCollection.updateOne(
              userQuery,
              {
                $set: { role: "rider" },
              },
              { session },
            );
          }
        });

        res.send({
          success: true,
          riderUpdateResult,
          userUpdateResult,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: error.message,
        });
      } finally {
        await session.endSession();
      }
    });

    app.patch("/users/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const roleInfo = req.body;
      const query = { _id: new ObjectId(id) };
      const update = {
        $set: {
          role: roleInfo.role,
        },
      };
      const result = await userCollection.updateOne(query, update);
      res.send(result);
    });

    app.get("/users/profile", verifyToken, async (req, res) => {
      try {
        const email = req.query.email;

        if (!email) {
          return res.status(400).send({ message: "Email is required" });
        }

        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "Forbidden Access" });
        }

        const user = await userCollection.findOne({ email });

        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send(user);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.get("/users/:email/role", verifyToken, async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await userCollection.findOne(query);
      res.send({ role: user?.role });
    });
    app.get("/users/:id", async (req, res) => {});

    app.get("/track/:trackingId", async (req, res) => {
      const trackingId = req.params.trackingId;

      console.log("tracking id", trackingId);
      const result = await trackingCollection.find({ trackingId }).toArray();
      res.send(result);
    });
    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    // console.log(
    //   "Pinged your deployment. You successfully connected to MongoDB!",
    // );
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
