import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { MongoClient, Db } from 'mongodb';

dotenv.config();

const app: Express = express();
const port = process.env.PORT || 5000;

app.use(cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
  credentials: true
}));

app.use(express.json());

// MongoDB connection with fallback
export let db: Db | null = null;
let client: MongoClient | null = null;

async function connectDB() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.warn("MONGODB_URI is not defined in environment variables. Falling back to in-memory mode.");
    return;
  }

  try {
    client = new MongoClient(mongoUri);
    await client.connect();
    db = client.db();
    console.log("Connected to MongoDB successfully.");
  } catch (error: any) {
    console.error("Failed to connect to MongoDB, falling back to in-memory mode. Error:", error.message);
    db = null;
  }
}

connectDB();

app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    database: db ? 'mongodb' : 'memory'
  });
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
