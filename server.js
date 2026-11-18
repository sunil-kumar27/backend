require("dotenv").config();

const express = require("express");
const { MongoClient } = require("mongodb");
const path = require("node:path");

const app = express();
const port = Number(process.env.PORT) || 3000;
const mongoUri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DATABASE || "shopease";
const adminApiKey = process.env.ADMIN_API_KEY;

if (!mongoUri) {
    console.error("MONGODB_URI is required. Copy .env.example to .env and add your Atlas connection string.");
    process.exit(1);
}
if (!adminApiKey) {
    console.error("ADMIN_API_KEY is required. Set a private key in backend/.env.");
    process.exit(1);
}

const client = new MongoClient(mongoUri);
let products;
let orders;

app.use(express.json({ limit: "4mb" }));

function requireAdmin(req, res, next) {
    if (req.get("authorization") !== `Bearer ${adminApiKey}`) {
        return res.status(401).json({ error: "Admin authorization required." });
    }
    next();
}

function validProduct(product) {
    return product && Number.isSafeInteger(product.id) && product.id > 0
        && typeof product.name === "string" && product.name.trim().length > 0 && product.name.length <= 80
        && Number.isFinite(product.price) && product.price > 0
        && typeof product.category === "string" && product.category.trim().length > 0 && product.category.length <= 40
        && typeof product.image === "string" && product.image.length <= 3_000_000
        && Number.isSafeInteger(product.stock) && product.stock >= 0;
}

app.get("/api/health", (_req, res) => res.json({ ok: true, database: databaseName }));

app.get("/api/products", async (_req, res, next) => {
    try {
        const result = await products.find({}, { projection: { _id: 0 } }).sort({ id: 1 }).toArray();
        res.json(result);
    } catch (error) { next(error); }
});

app.put("/api/products", requireAdmin, async (req, res, next) => {
    try {
        if (!Array.isArray(req.body) || req.body.length > 500 || !req.body.every(validProduct)
            || new Set(req.body.map(item => item.id)).size !== req.body.length) {
            return res.status(400).json({ error: "Invalid product catalog." });
        }
        const operations = req.body.map(product => ({
            replaceOne: { filter: { id: product.id }, replacement: product, upsert: true }
        }));
        const ids = req.body.map(product => product.id);
        const result = operations.length ? await products.bulkWrite(operations) : { modifiedCount: 0, upsertedCount: 0 };
        await products.deleteMany({ id: { $nin: ids } });
        res.json({ ok: true, modified: result.modifiedCount + result.upsertedCount });
    } catch (error) { next(error); }
});

app.post("/api/orders", async (req, res, next) => {
    try {
        const order = req.body;
        if (!order || typeof order.id !== "string" || order.id.length > 40
            || typeof order.customer !== "string" || order.customer.trim().length < 1 || order.customer.length > 120
            || typeof order.email !== "string" || order.email.length > 254
            || typeof order.phone !== "string" || order.phone.length > 40
            || typeof order.address !== "string" || order.address.length > 500
            || !Array.isArray(order.items) || order.items.length < 1 || order.items.length > 100
            || !order.items.every(item => Number.isSafeInteger(item.id) && typeof item.name === "string"
                && Number.isFinite(item.price) && item.price >= 0 && Number.isSafeInteger(item.quantity) && item.quantity > 0)
            || !Number.isFinite(order.total) || order.total < 0) {
            return res.status(400).json({ error: "Invalid order." });
        }
        const savedOrder = {
            id: order.id,
            createdAt: new Date().toISOString(),
            customer: order.customer.trim(), email: order.email.trim(), phone: order.phone.trim(),
            address: order.address, payment: String(order.payment || ""), items: order.items,
            total: 0, status: "New", tracking: ""
        };
        const session = client.startSession();
        try {
            await session.withTransaction(async () => {
                let verifiedTotal = 0;
                const verifiedItems = [];
                for (const item of savedOrder.items) {
                    const product = await products.findOne({ id: item.id }, { session });
                    if (!product || product.stock < item.quantity) throw Object.assign(new Error("Insufficient stock."), { status: 409 });
                    verifiedTotal += product.price * item.quantity;
                    verifiedItems.push({ id: product.id, name: product.name, price: product.price, quantity: item.quantity });
                    const changed = await products.updateOne(
                        { id: item.id, stock: { $gte: item.quantity } },
                        { $inc: { stock: -item.quantity } }, { session }
                    );
                    if (!changed.modifiedCount) throw Object.assign(new Error("Insufficient stock."), { status: 409 });
                }
                savedOrder.total = verifiedTotal;
                savedOrder.items = verifiedItems;
                await orders.insertOne(savedOrder, { session });
            });
        } finally { await session.endSession(); }
        res.status(201).json(savedOrder);
    } catch (error) { next(error); }
});

app.put("/api/orders", requireAdmin, async (req, res, next) => {
    try {
        if (!Array.isArray(req.body) || req.body.length > 10000
            || !req.body.every(order => order && typeof order.id === "string"
                && typeof order.customer === "string" && Array.isArray(order.items)
                && Number.isFinite(order.total) && order.total >= 0)) {
            return res.status(400).json({ error: "Invalid order list." });
        }
        for (const order of req.body) {
            await orders.updateOne({ id: order.id }, { $set: {
                status: String(order.status || "New"), tracking: String(order.tracking || "")
            } });
        }
        res.json({ ok: true });
    } catch (error) { next(error); }
});

app.get("/api/orders", requireAdmin, async (_req, res, next) => {
    try { res.json(await orders.find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray()); }
    catch (error) { next(error); }
});

app.patch("/api/orders/:id", requireAdmin, async (req, res, next) => {
    try {
        const update = {};
        if (typeof req.body.status === "string" && req.body.status.length <= 40) update.status = req.body.status;
        if (typeof req.body.tracking === "string" && req.body.tracking.length <= 100) update.tracking = req.body.tracking;
        if (!Object.keys(update).length) return res.status(400).json({ error: "No valid order fields provided." });
        const result = await orders.findOneAndUpdate({ id: req.params.id }, { $set: update }, {
            returnDocument: "after", projection: { _id: 0 }
        });
        if (!result) return res.status(404).json({ error: "Order not found." });
        res.json(result);
    } catch (error) { next(error); }
});

app.use("/admin-panel", express.static(path.join(__dirname, "..", "admin panel")));
app.use(express.static(path.join(__dirname, "..", "user site")));
app.get("/admin", (_req, res) => res.redirect("/admin-panel/admin.html"));

app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(error.status || 500).json({ error: error.status ? error.message : "The server could not complete the request." });
});

async function start() {
    await client.connect();
    const database = client.db(databaseName);
    products = database.collection("products");
    orders = database.collection("orders");
    await products.createIndex({ id: 1 }, { unique: true });
    await orders.createIndex({ id: 1 }, { unique: true });
    app.listen(port, () => console.log(`ShopEase is running at http://localhost:${port}`));
}

start().catch(error => {
    console.error("Could not connect to MongoDB Atlas:", error.message);
    process.exit(1);
});

process.on("SIGINT", async () => { await client.close(); process.exit(0); });
