# MongoDB Atlas backend

ShopEase uses MongoDB through this server. The browser never receives the Atlas connection string; it stays in `backend/.env`.

## Set up

1. In Atlas, rotate the database user's password shown in the screenshot, then copy the new connection string from **Connect → Drivers**.
2. Copy `backend/.env.example` to `backend/.env`, replace the placeholders, and set a long random `ADMIN_API_KEY`.
3. From this directory, run `npm install`, then `npm start`.
4. Open the storefront at `http://localhost:3000` and the admin panel at `http://localhost:3000/admin`.
5. On first admin use, enter the same `ADMIN_API_KEY` once per browser session.

The first catalog is the sample catalog built into the storefront. Save products from the admin panel to write that catalog to MongoDB. New checkouts are saved in MongoDB and inventory is validated and decremented on the server. In the combined project, this server also serves the neighboring `user site` and `admin panel` folders; in a standalone backend checkout it provides the API routes only.

Atlas must allow connections from the machine running this server. Restrict the Atlas network access list to trusted IP addresses; do not use a public `0.0.0.0/0` rule for a deployed store.

## Collections

- `products`: catalog and inventory, keyed by numeric `id`.
- `orders`: customer details, line items, verified totals, status, and tracking, keyed by string `id`.

Public routes read the catalog and submit checkout orders. Admin catalog writes and order reads/updates require the bearer key configured in `ADMIN_API_KEY`.
