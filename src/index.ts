import express, { type Request, type Response } from 'express';
import { MongoClient, Db, ObjectId } from 'mongodb';
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



// ── MongoDB connection ─────────────────────────────
if (!MONGODB_URI) {
  throw new Error(
    'Please define the MONGODB_URI environment variable inside .env',
  );
}

const client = new MongoClient(MONGODB_URI);
let db: Db;
let userCollection: any;
let blueprintCollection: any;

export async function connectToDatabase(): Promise<Db> {
  if (db) return db;

  try {
    await client.connect();
    console.log('Successfully connected to MongoDB server.');
    db = client.db("archflow");
    userCollection = db.collection('user');
    blueprintCollection = db.collection('blueprints');
    return db;
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
  }
}


// routes

// get all blueprints
app.get('/api/all-blueprints', async (req: Request, res: Response) => {
  try {
    const blueprints = await blueprintCollection.find().sort({ createdAt: -1, _id: -1 }).toArray();
    res.status(200).json(blueprints);
  } catch (error) {
    console.error('Failed to get blueprints:', error);
    res.status(500).json({ error: 'Failed to get blueprints' });
  }
});

// get blueprints (with optional query filter)
app.get('/api/blueprints', async (req: Request, res: Response) => {
  try {
    const { creatorId } = req.query;
    let query: any = {};
    if (creatorId && !creatorId.toString().includes('demo')) {
      query = { 
        $or: [
          { creatorId }, 
          { userId: creatorId }, 
          { author: creatorId },
          { email: creatorId }
        ] 
      };
    }
    let blueprints = await blueprintCollection.find(query).sort({ createdAt: -1, _id: -1 }).toArray();
    
    // Fallback: If no blueprints match the query, return all blueprints
    if (blueprints.length === 0) {
      blueprints = await blueprintCollection.find().sort({ createdAt: -1, _id: -1 }).toArray();
    }
    
    res.status(200).json(blueprints);
  } catch (error) {
    console.error('Failed to query blueprints:', error);
    res.status(500).json({ error: 'Failed to query blueprints' });
  }
});

// get blueprint by id
app.get('/api/blueprints/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    let query: any = {};
    if (ObjectId.isValid(id)) {
      query = { _id: new ObjectId(id) };
    } else {
      query = { $or: [{ id: Number(id) || id }, { _id: id }] };
    }
    const blueprint = await blueprintCollection.findOne(query);
    if (!blueprint) {
      res.status(404).json({ error: 'Blueprint not found' });
      return;
    }
    res.status(200).json(blueprint);
  } catch (error) {
    console.error('Failed to get blueprint:', error);
    res.status(500).json({ error: 'Failed to get blueprint' });
  }
});

// post blueprint
app.post('/api/blueprints', async (req: Request, res: Response) => {
  try {
    const blueprint = req.body;
    const result = await blueprintCollection.insertOne(blueprint);
    res.status(200).json(result);
  } catch (error) {
    console.error('Failed to create blueprint:', error);
    res.status(500).json({ error: 'Failed to create blueprint' });
  }
});

// get and manage blueprints of a user by his email
// get blueprint by email
app.get('/api/my-blueprints/:email', async (req: Request, res: Response) => {
  try {
    const { email } = req.params;
    let query: any = {
      $or: [
        { email },
        { author: email }
      ]
    };
    let blueprints = await blueprintCollection.find(query).sort({ createdAt: -1, _id: -1 }).toArray();
    
    // Fallback: If no blueprints are found for this email, or if it is the demo user,
    // return all blueprints so the user can manage existing projects.
    if (blueprints.length === 0 || email === 'demo@archflow.com') {
      blueprints = await blueprintCollection.find().sort({ createdAt: -1, _id: -1 }).toArray();
    }
    
    res.status(200).json(blueprints);
  } catch (error) {
    console.error('Failed to get blueprints:', error);
    res.status(500).json({ error: 'Failed to get blueprints' });
  }
});

// update blueprint
app.patch('/api/blueprints/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const blueprint = req.body;
    let query: any = {};
    if (ObjectId.isValid(id)) {
      query = { _id: new ObjectId(id) };
    } else {
      query = { $or: [{ id: Number(id) || id }, { _id: id }] };
    }
    const result = await blueprintCollection.updateOne(query, { $set: blueprint });
    if (result.matchedCount === 0) {
      res.status(404).json({ error: 'Blueprint not found' });
      return;
    }
    res.status(200).json(result);
  } catch (error) {
    console.error('Failed to update blueprint:', error);
    res.status(500).json({ error: 'Failed to update blueprint' });
  }
});

// delete blueprint
app.delete('/api/my-blueprints/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    let query: any = {};
    if (ObjectId.isValid(id)) {
      query = { _id: new ObjectId(id) };
    } else {
      query = { $or: [{ id: Number(id) || id }, { _id: id }] };
    }
    const result = await blueprintCollection.deleteOne(query);
    if (result.deletedCount === 0) {
      res.status(404).json({ error: 'Blueprint not found' });
      return;
    }
    res.status(200).json(result);
  } catch (error) {
    console.error('Failed to delete blueprint:', error);
    res.status(500).json({ error: 'Failed to delete blueprint' });
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
