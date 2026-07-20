import express, { type Request, type Response } from 'express';
import { MongoClient, Db } from 'mongodb';
import cors from 'cors';
import dotenv from 'dotenv';
import { features } from 'node:process';
// import { createRemoteJWKSet, jwtVerify } from 'jose-cjs';
// import Stripe from 'stripe';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI as string;
// const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
// const STRIPE_SUCCESS_URL = process.env.STRIPE_SUCCESS_URL ||
//   `${CLIENT_URL}/dashboard/supporter/purcess`;
// const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// const JWKS = createRemoteJWKSet(new URL(`${CLIENT_URL}/api/auth/jwks`));

const blueprintsCollection = [
  {
    title: 'Blueprint title',
    description: 'description',
    teckStack: ['Nextjs', 'React', 'MongoDB'],
    complexcity: 'medium',
    architectureFlow: {
      architecture: {
       
            title: 'Architecture step 1',
            description: 'Architecture step 1 description',
      },
      features: {
            title: 'Features step 1',
            description: 'Features step 1 description',
      },
      plan: {
            title: 'Plan step 1',
            description: 'Plan step 1 description',
          }
    },
    status: 'ready',
    rating: 5,
    author: 'hasan@gmail.com',
  },
];

// ── MongoDB connection ─────────────────────────────
if (!MONGODB_URI) {
  throw new Error(
    'Please define the MONGODB_URI environment variable inside .env',
  );
}

const client = new MongoClient(MONGODB_URI);
let dbConnection: Db;

export async function connectToDatabase(): Promise<Db> {
  if (dbConnection) return dbConnection;

  try {
    await client.connect();
    console.log('Successfully connected to MongoDB server.');
    dbConnection = client.db();
    return dbConnection;
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
    process.exit(1);
  }
}

// routes

app.get('/api/all-blueprints', async (req: Request, res: Response) => {
  try {
    const blueprints = blueprintsCollection;
    res.status(200).json(blueprints);
  } catch (error) {
    console.error('Failed to get blueprints:', error);
    res.status(500).json({ error: 'Failed to get blueprints' });
  }
});




// ─── ROOT ──────────────────────────────────────────────────────────────────
app.get('/', (req: Request, res: Response) => {
  res.send('Hello World!');
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});

connectToDatabase();
