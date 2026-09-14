import express, { type Request, type Response } from 'express';
import { MongoClient, Db, ObjectId } from 'mongodb';
import cors from 'cors';
import dotenv from 'dotenv';
import { createRemoteJWKSet, jwtVerify } from 'jose-cjs';
// import Stripe from 'stripe';

dotenv.config();

const app = express();
app.use(cors());

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';

app.use(
  cors({
    origin: [CLIENT_URL, 'http://localhost:3000', 'https://archflow-client.vercel.app'].filter(Boolean),
    credentials: true,
  })
);
app.use(express.json());

// JWKS remote key set setup (fetches public keys from Next.js better-auth JWKS endpoint)
const JWKS = createRemoteJWKSet(new URL(`${CLIENT_URL}/api/auth/jwks`));

// JWT Token Verification Middleware
export const verifyToken = async (req: Request, res: Response, next: any) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: Missing or invalid token format' });
    return;
  }

  const token = authHeader.split(' ')[1];

  if (!token) {
    res.status(401).json({ error: 'Unauthorized: Token missing' });
    return;
  }

  try {
    const { payload } = await jwtVerify(token, JWKS);
    (req as any).user = payload;
    next();
  } catch (error) {
    console.error('JWT Verification error:', error);
    res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
    return;
  }
};

// Database connection middleware for Serverless environment
app.use(async (req: Request, res: Response, next) => {
  try {
    await connectToDatabase();
    next();
  } catch (error) {
    console.error('Database connection failed:', error);
    res.status(500).json({ error: 'Database connection failed' });
  }
});

const port = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI as string;

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
    db = client.db('archflow');
    userCollection = db.collection('user');
    blueprintCollection = db.collection('blueprints');
    return db;
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
    throw error;
  }
}

// routes

// get all blueprints (public feed with MongoDB query search, filter, and pagination)
app.get('/api/all-blueprints', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const limit = Math.max(1, Math.min(50, parseInt(String(req.query.limit || '6'), 10)));
    const search = String(req.query.search || '').trim();
    const stack = String(req.query.stack || '').trim();
    const complexity = String(req.query.complexity || '').trim();
    const sort = String(req.query.sort || 'newest').trim();

    const andConditions: any[] = [{ visibility: { $ne: 'private' } }];

    if (search) {
      andConditions.push({
        $or: [
          { title: { $regex: search, $options: 'i' } },
          { description: { $regex: search, $options: 'i' } },
          { prompt: { $regex: search, $options: 'i' } },
        ],
      });
    }

    if (stack && stack.toLowerCase() !== 'all') {
      andConditions.push({
        $or: [
          { teckStack: { $regex: stack, $options: 'i' } },
          { stack: { $regex: stack, $options: 'i' } },
        ],
      });
    }

    if (complexity && complexity.toLowerCase() !== 'all') {
      andConditions.push({
        $or: [
          { complexcity: { $regex: `^${complexity}$`, $options: 'i' } },
          { complexity: { $regex: `^${complexity}$`, $options: 'i' } },
        ],
      });
    }

    const query = andConditions.length > 1 ? { $and: andConditions } : andConditions[0];

    let sortObj: any = { createdAt: -1, _id: -1 };
    if (sort === 'oldest') {
      sortObj = { createdAt: 1, _id: 1 };
    } else if (sort === 'rating') {
      sortObj = { rating: -1, createdAt: -1 };
    }
    const skip = (page - 1) * limit;
    const blueprints = await blueprintCollection
      .find(query)
      .sort(sortObj)
      .skip(skip)
      .limit(limit)
      .toArray();

    const totalData = await blueprintCollection.countDocuments(query);
    const totalPage = Math.ceil(totalData / limit) || 1;

    // If client requested flat array (legacy caller with no page query)
    if (!req.query.page && !req.query.limit && !req.query.search) {
      res.status(200).json(blueprints);
      return;
    }

    res.status(200).json({
      data: blueprints,
      blueprints,
      totalData,
      total: totalData,
      page,
      limit,
      totalPage,
      totalPages: totalPage,
    });
  } catch (error) {
    console.error('Failed to get blueprints:', error);
    res.status(500).json({ error: 'Failed to get blueprints' });
  }
});

// get blueprints (with optional query filter) (public feed excludes private unless creator query)
app.get('/api/blueprints', async (req: Request, res: Response) => {
  try {
    const { creatorId } = req.query;
    let query: any = {};
    if (creatorId) {
      let userEmail = '';
      try {
        let userQuery: any = {};
        if (ObjectId.isValid(creatorId.toString())) {
          userQuery = { _id: new ObjectId(creatorId.toString()) };
        } else {
          userQuery = { _id: creatorId.toString() };
        }
        const user = await userCollection.findOne(userQuery);
        if (user && user.email) {
          userEmail = user.email;
        }
      } catch (err) {
        console.error('Failed to look up user by creatorId:', err);
      }

      query = {
        $or: [
          { creatorId },
          { userId: creatorId },
          { author: creatorId },
          { email: creatorId },
        ],
      };

      if (userEmail) {
        query.$or.push({ author: userEmail });
        query.$or.push({ email: userEmail });
      }
    } else {
      // General explore feed: only public
      query = { visibility: { $ne: 'private' } };
    }
    let blueprints = await blueprintCollection
      .find(query)
      .sort({ createdAt: -1, _id: -1 })
      .toArray();

    // Fallback: Only if no creatorId is provided
    if (!creatorId && blueprints.length === 0) {
      blueprints = await blueprintCollection
        .find({ visibility: { $ne: 'private' } })
        .sort({ createdAt: -1, _id: -1 })
        .toArray();
    }

    res.status(200).json(blueprints);
  } catch (error) {
    console.error('Failed to query blueprints:', error);
    res.status(500).json({ error: 'Failed to query blueprints' });
  }
});

// get blueprint by id (owner can view their own private blueprint)
app.get('/api/blueprints/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (typeof id !== 'string') {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }
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

    // If private blueprint, verify requester owns it
    if (blueprint.visibility === 'private') {
      let requesterEmail = '';
      let requesterId = '';

      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const token = authHeader.split(' ')[1];
          const { payload } = await jwtVerify(token, JWKS);
          requesterEmail = payload?.email ? String(payload.email).toLowerCase() : '';
          requesterId = String(payload?.id || payload?.sub || '');
        } catch (jwtErr) {
          // Token expired or server component internal token
        }
      }

      // Check forwarded server-component headers
      if (!requesterEmail && req.headers['x-user-email']) {
        requesterEmail = String(req.headers['x-user-email']).toLowerCase();
      }
      if (!requesterId && req.headers['x-user-id']) {
        requesterId = String(req.headers['x-user-id']);
      }

      const isOwner =
        (blueprint.author && String(blueprint.author).toLowerCase() === requesterEmail) ||
        (blueprint.email && String(blueprint.email).toLowerCase() === requesterEmail) ||
        (blueprint.creatorId && String(blueprint.creatorId) === requesterId);

      if (!isOwner) {
        res.status(403).json({ error: 'Forbidden: You do not have permission to view this private blueprint.' });
        return;
      }
    }

    res.status(200).json(blueprint);
  } catch (error) {
    console.error('Failed to get blueprint:', error);
    res.status(500).json({ error: 'Failed to get blueprint' });
  }
});

// dynamic rating endpoint (users rate 1-5 stars)
app.post('/api/blueprints/:id/rate', async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id || typeof id !== 'string') {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }
    const { rating } = req.body;
    const numRating = Number(rating);

    if (!numRating || numRating < 1 || numRating > 5) {
      res.status(400).json({ error: 'Rating must be between 1 and 5' });
      return;
    }

    let query: any = {};
    if (ObjectId.isValid(id)) {
      query = { _id: new ObjectId(id) };
    } else {
      query = { $or: [{ id: Number(id) || id }, { _id: id }] };
    }

    const bp = await blueprintCollection.findOne(query);
    if (!bp) {
      res.status(404).json({ error: 'Blueprint not found' });
      return;
    }

    const currentRatings: number[] = Array.isArray(bp.ratings) ? bp.ratings : [];
    currentRatings.push(numRating);
    const avg = Number((currentRatings.reduce((a, b) => a + b, 0) / currentRatings.length).toFixed(1));

    await blueprintCollection.updateOne(query, {
      $set: {
        ratings: currentRatings,
        rating: avg,
        ratingsCount: currentRatings.length,
      },
    });

    res.status(200).json({ success: true, rating: avg, ratingsCount: currentRatings.length });
  } catch (error) {
    console.error('Failed to rate blueprint:', error);
    res.status(500).json({ error: 'Failed to rate blueprint' });
  }
});

// get user blueprint quota/subscription & tier status (protected with verifyToken)
app.get('/api/user/quota/:email', verifyToken, async (req: Request, res: Response) => {
  try {
    const emailParam = String(req.params.email || '').toLowerCase();
    const userPayload = (req as any).user;

    if (userPayload?.email && userPayload.email.toLowerCase() !== emailParam) {
      res.status(403).json({ error: 'Forbidden: Cannot access other users quota' });
      return;
    }

    // Lookup user record to verify role/plan
    let userFilter: any = { email: emailParam };
    if (userPayload?.id && ObjectId.isValid(userPayload.id)) {
      userFilter = { $or: [{ email: emailParam }, { _id: new ObjectId(userPayload.id) }, { _id: userPayload.id }] };
    }
    const user = await userCollection.findOne(userFilter);

    const role = String(user?.role || user?.plan || 'free').toLowerCase();
    const isPro = role === 'pro' || role === 'admin';

    if (isPro) {
      // Pro: Max 10 per 24 hours
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const count = await blueprintCollection.countDocuments({
        $or: [
          { creatorId: userPayload.id || userPayload.sub },
          { author: emailParam },
          { email: emailParam },
        ],
        createdAt: { $gte: twentyFourHoursAgo },
      });
      const max = 10;
      const remaining = Math.max(0, max - count);
      res.status(200).json({
        role: 'pro',
        plan: 'pro',
        isPro: true,
        count,
        max,
        remaining,
        canGenerate: count < max,
      });
    } else {
      // Free: Max 3 lifetime
      const count = await blueprintCollection.countDocuments({
        $or: [
          { creatorId: userPayload.id || userPayload.sub },
          { author: emailParam },
          { email: emailParam },
        ],
      });
      const max = 3;
      const remaining = Math.max(0, max - count);
      res.status(200).json({
        role: 'free',
        plan: 'free',
        isPro: false,
        count,
        max,
        remaining,
        canGenerate: count < max,
      });
    }
  } catch (error) {
    console.error('Failed to get quota:', error);
    res.status(500).json({ error: 'Failed to fetch user quota' });
  }
});

// post blueprint (protected with verifyToken + quota enforcement)
app.post('/api/blueprints', verifyToken, async (req: Request, res: Response) => {
  try {
    const blueprint = req.body;
    const userPayload = (req as any).user;
    const userEmail = userPayload?.email ? String(userPayload.email).toLowerCase() : '';
    const userId = userPayload?.id || userPayload?.sub || '';

    if (!userEmail) {
      res.status(400).json({ error: 'User email required from auth session' });
      return;
    }

    // Lookup user record to determine role
    let userFilter: any = { email: userEmail };
    if (userId && ObjectId.isValid(userId)) {
      userFilter = { $or: [{ email: userEmail }, { _id: new ObjectId(userId) }, { _id: userId }] };
    }
    const user = await userCollection.findOne(userFilter);
    const role = String(user?.role || user?.plan || 'free').toLowerCase();
    const isPro = role === 'pro' || role === 'admin';

    // Enforce quotas
    if (isPro) {
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const dailyCount = await blueprintCollection.countDocuments({
        $or: [{ creatorId: userId }, { author: userEmail }, { email: userEmail }],
        createdAt: { $gte: twentyFourHoursAgo },
      });

      if (dailyCount >= 10) {
        res.status(429).json({
          error: 'Daily generation limit reached (10/10 in 24 hours). Please try again tomorrow.',
          limitReached: true,
          role: 'pro',
          count: dailyCount,
          max: 10,
        });
        return;
      }
      // Pro can be private or public
      blueprint.visibility = blueprint.visibility === 'private' ? 'private' : 'public';
    } else {
      const lifetimeCount = await blueprintCollection.countDocuments({
        $or: [{ creatorId: userId }, { author: userEmail }, { email: userEmail }],
      });

      if (lifetimeCount >= 3) {
        res.status(403).json({
          error: 'Free tier generation limit reached (3/3). Upgrade to Developer Pro for unlimited generations.',
          limitReached: true,
          role: 'free',
          count: lifetimeCount,
          max: 3,
        });
        return;
      }
      // Free must always be public
      blueprint.visibility = 'public';
    }

    // Metadata binding
    blueprint.author = blueprint.author || userEmail;
    blueprint.email = userEmail;
    blueprint.creatorId = userId;
    blueprint.createdAt = blueprint.createdAt || new Date().toISOString();
    blueprint.updatedAt = new Date().toISOString();

    const result = await blueprintCollection.insertOne(blueprint);
    res.status(200).json({ ...result, insertedId: result.insertedId, blueprintId: result.insertedId });
  } catch (error) {
    console.error('Failed to create blueprint:', error);
    res.status(500).json({ error: 'Failed to create blueprint' });
  }
});

// get user blueprints by email (protected with verifyToken + MongoDB search)
app.get('/api/my-blueprints/:email', verifyToken, async (req: Request, res: Response) => {
  try {
    const emailParam = String(req.params.email || '').toLowerCase();
    const userPayload = (req as any).user;
    const search = String(req.query.search || '').trim();

    // Verify token payload email matches requested email
    if (userPayload && userPayload.email && userPayload.email.toLowerCase() !== emailParam.toLowerCase()) {
      res.status(403).json({ error: 'Forbidden: You cannot access other users blueprints' });
      return;
    }

    const ownershipCondition: any = {
      $or: [
        { author: emailParam },
        { email: emailParam },
        ...(userPayload?.id ? [{ creatorId: userPayload.id }, { userId: userPayload.id }] : []),
      ],
    };

    let query: any = ownershipCondition;
    if (search) {
      query = {
        $and: [
          ownershipCondition,
          {
            $or: [
              { title: { $regex: search, $options: 'i' } },
              { description: { $regex: search, $options: 'i' } },
              { prompt: { $regex: search, $options: 'i' } },
            ],
          },
        ],
      };
    }

    const { page, limit } = req.query;
    if (page && limit) {
      const skip = (Number(page) - 1) * Number(limit);
      const blueprints = await blueprintCollection
        .find(query)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(Number(limit))
        .toArray();
      const totalData = await blueprintCollection.countDocuments(query);
      const totalPage = Math.ceil(totalData / Number(limit)) || 1;
      res.status(200).json({
        data: blueprints,
        blueprints,
        totalData,
        total: totalData,
        totalPage,
        totalPages: totalPage,
        page: Number(page),
        limit: Number(limit),
      });
      return;
    }

    let blueprints = await blueprintCollection
      .find(query)
      .sort({ createdAt: -1, _id: -1 })
      .toArray();

    res.status(200).json(blueprints);
  } catch (error) {
    console.error('Failed to get blueprints:', error);
    res.status(500).json({ error: 'Failed to get blueprints' });
  }
});

// update blueprint (protected with verifyToken + safe immutable field exclusion)
app.patch('/api/blueprints/:id', verifyToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (typeof id !== 'string') {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }

    const userPayload = (req as any).user;
    const userEmail = userPayload?.email ? String(userPayload.email).toLowerCase() : '';

    // Verify user is Pro
    const userDoc = await userCollection.findOne({ email: userEmail });
    const isPro =
      userDoc?.role === 'pro' ||
      userDoc?.role === 'admin' ||
      userDoc?.plan === 'pro' ||
      userPayload?.role === 'pro' ||
      userPayload?.role === 'admin';

    if (!isPro) {
      res.status(403).json({ error: 'Forbidden: Blueprint editing is exclusive to Pro members.' });
      return;
    }

    const updatePayload = { ...req.body };

    // Strip immutable fields
    delete updatePayload._id;
    delete updatePayload.creatorId;
    delete updatePayload.author;
    delete updatePayload.email;
    delete updatePayload.createdAt;
    delete updatePayload.rating;
    delete updatePayload.totalRatings;
    delete updatePayload.averageRating;
    delete updatePayload.reviews;
    updatePayload.updatedAt = new Date().toISOString();

    let query: any = {};
    if (ObjectId.isValid(id)) {
      query = { _id: new ObjectId(id) };
    } else {
      query = { $or: [{ id: Number(id) || id }, { _id: id }] };
    }

    const result = await blueprintCollection.updateOne(query, {
      $set: updatePayload,
    });
    if (result.matchedCount === 0) {
      res.status(404).json({ error: 'Blueprint not found' });
      return;
    }
    res.status(200).json({ success: true, modifiedCount: result.modifiedCount });
  } catch (error) {
    console.error('Failed to update blueprint:', error);
    res.status(500).json({ error: 'Failed to update blueprint' });
  }
});

// delete blueprint (protected with verifyToken)
app.delete('/api/my-blueprints/:id', verifyToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (typeof id !== 'string') {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }
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
  res.send('Archflow Server is running fine!');
});

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Archflow server listening on port ${port}`);
  });
}

connectToDatabase();

export default app;
