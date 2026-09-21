import express, { type Request, type Response } from 'express';
import { MongoClient, Db, ObjectId } from 'mongodb';
import cors from 'cors';
import dotenv from 'dotenv';
import { createRemoteJWKSet, jwtVerify } from 'jose-cjs';
// import Stripe from 'stripe';

dotenv.config();

const app = express();

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';
const INTERNAL_SECRET = process.env.INTERNAL_SERVER_SECRET || 'archflow-internal-secure-comm';

const allowedOrigins = [
  CLIENT_URL,
  'http://localhost:3000',
  'https://archflow-web-ai.vercel.app',
  'https://archflow-client.vercel.app',
].filter(Boolean) as string[];

app.use(
  cors({
    origin: (origin, callback) => {
      if (
        !origin ||
        allowedOrigins.includes(origin) ||
        allowedOrigins.includes(origin.replace(/\/$/, ''))
      ) {
        return callback(null, true);
      }
      return callback(new Error('Blocked by CORS policy'));
    },
    credentials: true,
  })
);
app.use(express.json());

// Helper function to safely escape regex input to prevent ReDoS / NoSQL injection
const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// JWKS remote key set setup (fetches public keys from Next.js better-auth JWKS endpoint)
const JWKS = createRemoteJWKSet(new URL(`${CLIENT_URL}/api/auth/jwks`));

// JWT Token Verification Middleware
export const verifyToken = async (req: Request, res: Response, next: any) => {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    if (token) {
      try {
        const { payload } = await jwtVerify(token, JWKS);
        (req as any).user = payload;
        next();
        return;
      } catch (error) {
        console.error('JWT Verification error:', error);
      }
    }
  }

  // Fallback: identity forwarded from Next.js server actions with internal signature verification
  const forwardEmail = req.headers['x-user-email'];
  const forwardId = req.headers['x-user-id'];
  const internalSecret = req.headers['x-internal-secret'];

  if (forwardEmail || forwardId) {
    if (internalSecret !== INTERNAL_SECRET) {
      res.status(401).json({ error: 'Unauthorized: Invalid internal signature' });
      return;
    }
    (req as any).user = {
      email: forwardEmail ? String(forwardEmail).toLowerCase() : undefined,
      id: forwardId ? String(forwardId) : undefined,
      sub: forwardId ? String(forwardId) : undefined,
    };
    next();
    return;
  }

  res.status(401).json({ error: 'Unauthorized: Missing or invalid token format' });
};

// Admin Authorization Middleware (verifies caller has admin role in userCollection)
export const verifyAdmin = async (req: Request, res: Response, next: any) => {
  try {
    const userPayload = (req as any).user;
    const userId = String(userPayload?.id || userPayload?.sub || '');
    const userEmail = userPayload?.email ? String(userPayload.email).toLowerCase() : '';

    if (!userId && !userEmail) {
      res.status(401).json({ error: 'Unauthorized: User identity missing' });
      return;
    }

    let userFilter: any = { email: userEmail };
    if (userId && ObjectId.isValid(userId)) {
      userFilter = { $or: [{ email: userEmail }, { _id: new ObjectId(userId) }, { _id: userId }] };
    }
    const user = await userCollection.findOne(userFilter);
    const role = String(user?.role || '').toLowerCase();

    if (role !== 'admin') {
      res.status(403).json({ error: 'Forbidden: Administrator privileges required' });
      return;
    }

    (req as any).adminUser = user;
    next();
  } catch (err) {
    console.error('Admin verification error:', err);
    res.status(500).json({ error: 'Internal server error verifying admin' });
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
let bookmarkCollection: any;
let ratingCollection: any;
let transactionCollection: any;

export async function connectToDatabase(): Promise<Db> {
  if (db) return db;

  try {
    await client.connect();
    console.log('Successfully connected to MongoDB server.');
    db = client.db('archflow');
    userCollection = db.collection('user');
    blueprintCollection = db.collection('blueprints');
    bookmarkCollection = db.collection('bookmarks');
    bookmarkCollection.createIndex({ userId: 1, blueprintId: 1 }).catch(() => {});
    ratingCollection = db.collection('ratings');
    ratingCollection.createIndex({ userId: 1, blueprintId: 1 }).catch(() => {});
    transactionCollection = db.collection('transactions');
    transactionCollection.createIndex({ createdAt: -1 }).catch(() => {});
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
      const safeSearch = escapeRegex(search);
      andConditions.push({
        $or: [
          { title: { $regex: safeSearch, $options: 'i' } },
          { description: { $regex: safeSearch, $options: 'i' } },
          { prompt: { $regex: safeSearch, $options: 'i' } },
        ],
      });
    }

    if (stack && stack.toLowerCase() !== 'all') {
      const safeStack = escapeRegex(stack);
      andConditions.push({
        $or: [
          { teckStack: { $regex: safeStack, $options: 'i' } },
          { stack: { $regex: safeStack, $options: 'i' } },
        ],
      });
    }

    if (complexity && complexity.toLowerCase() !== 'all') {
      const safeComplexity = escapeRegex(complexity);
      andConditions.push({
        $or: [
          { complexcity: { $regex: `^${safeComplexity}$`, $options: 'i' } },
          { complexity: { $regex: `^${safeComplexity}$`, $options: 'i' } },
        ],
      });
    }

    const query = andConditions.length > 1 ? { $and: andConditions } : andConditions[0];

    let sortObj: any = { createdAt: -1, _id: -1 };
    if (sort === 'oldest') {
      sortObj = { createdAt: 1, _id: 1 };
    } else if (sort === 'rating') {
      sortObj = { rating: -1, createdAt: -1 };
    } else if (sort === 'views') {
      sortObj = { views: -1, createdAt: -1 };
    } else if (sort === 'downloads') {
      sortObj = { downloads: -1, createdAt: -1 };
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

// dynamic rating endpoint (each user can only rate each blueprint once)
app.post('/api/blueprints/:id/rate', verifyToken, async (req: Request, res: Response) => {
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

    const userPayload = (req as any).user;
    const userId = String(userPayload?.id || userPayload?.sub || '');
    const userEmail = userPayload?.email ? String(userPayload.email).toLowerCase() : '';

    if (!userId && !userEmail) {
      res.status(401).json({ error: 'Unauthorized: User identity missing' });
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

    // Check if this user has already rated this blueprint
    const existingRating = await ratingCollection.findOne({
      blueprintId: id,
      $or: [
        ...(userId ? [{ userId }] : []),
        ...(userEmail ? [{ userEmail }] : []),
      ],
    });

    if (existingRating) {
      res.status(400).json({ error: 'You have already rated this blueprint' });
      return;
    }

    // Record user rating in database
    await ratingCollection.insertOne({
      blueprintId: id,
      userId: userId || userEmail,
      userEmail,
      rating: numRating,
      createdAt: new Date().toISOString(),
    });

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

    res.status(200).json({
      success: true,
      rating: avg,
      ratingsCount: currentRatings.length,
      hasRated: true,
      userRating: numRating,
      message: 'Rating submitted successfully',
    });
  } catch (error) {
    console.error('Failed to rate blueprint:', error);
    res.status(500).json({ error: 'Failed to rate blueprint' });
  }
});

// get current user's rating status for a blueprint
app.get('/api/blueprints/:id/user-rating', verifyToken, async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id || typeof id !== 'string') {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }

    const userPayload = (req as any).user;
    const userId = String(userPayload?.id || userPayload?.sub || '');
    const userEmail = userPayload?.email ? String(userPayload.email).toLowerCase() : '';

    if (!userId && !userEmail) {
      res.status(200).json({ hasRated: false, userRating: null });
      return;
    }

    const ratingDoc = await ratingCollection.findOne({
      blueprintId: id,
      $or: [
        ...(userId ? [{ userId }] : []),
        ...(userEmail ? [{ userEmail }] : []),
      ],
    });

    if (ratingDoc) {
      res.status(200).json({ hasRated: true, userRating: ratingDoc.rating });
    } else {
      res.status(200).json({ hasRated: false, userRating: null });
    }
  } catch (error) {
    console.error('Failed to get user rating:', error);
    res.status(500).json({ error: 'Failed to get user rating' });
  }
});

// increment views endpoint
app.post('/api/blueprints/:id/view', async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id || typeof id !== 'string') {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }
    let query: any = {};
    if (ObjectId.isValid(id)) {
      query = { _id: new ObjectId(id) };
    } else {
      query = { $or: [{ id: Number(id) || id }, { _id: id }] };
    }

    const result = await blueprintCollection.findOneAndUpdate(
      query,
      { $inc: { views: 1 } },
      { returnDocument: 'after' }
    );

    res.status(200).json({ success: true, views: result?.views || 1 });
  } catch (error) {
    console.error('Failed to increment view count:', error);
    res.status(500).json({ error: 'Failed to increment view count' });
  }
});

// increment downloads endpoint
app.post('/api/blueprints/:id/download', async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id || typeof id !== 'string') {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }
    let query: any = {};
    if (ObjectId.isValid(id)) {
      query = { _id: new ObjectId(id) };
    } else {
      query = { $or: [{ id: Number(id) || id }, { _id: id }] };
    }

    const result = await blueprintCollection.findOneAndUpdate(
      query,
      { $inc: { downloads: 1 } },
      { returnDocument: 'after' }
    );

    res.status(200).json({ success: true, downloads: result?.downloads || 1 });
  } catch (error) {
    console.error('Failed to increment download count:', error);
    res.status(500).json({ error: 'Failed to increment download count' });
  }
});

// toggle bookmark for a blueprint (protected with verifyToken)
app.post('/api/blueprints/:id/bookmark', verifyToken, async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id || typeof id !== 'string') {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }

    const userPayload = (req as any).user;
    const userId = String(userPayload?.id || userPayload?.sub || '');
    const userEmail = userPayload?.email ? String(userPayload.email).toLowerCase() : '';

    if (!userId && !userEmail) {
      res.status(401).json({ error: 'Unauthorized: User identity missing' });
      return;
    }

    const query = {
      blueprintId: id,
      $or: [
        ...(userId ? [{ userId }] : []),
        ...(userEmail ? [{ userEmail }] : []),
      ],
    };

    const existing = await bookmarkCollection.findOne(query);

    if (existing) {
      await bookmarkCollection.deleteOne({ _id: existing._id });
      res.status(200).json({ success: true, isBookmarked: false, message: 'Removed from bookmarks' });
    } else {
      await bookmarkCollection.insertOne({
        blueprintId: id,
        userId: userId || userEmail,
        userEmail,
        createdAt: new Date().toISOString(),
      });
      res.status(200).json({ success: true, isBookmarked: true, message: 'Saved to bookmarks' });
    }
  } catch (error) {
    console.error('Failed to toggle bookmark:', error);
    res.status(500).json({ error: 'Failed to toggle bookmark' });
  }
});

// get all bookmarks for authenticated user (protected with verifyToken)
app.get('/api/user/bookmarks', verifyToken, async (req: Request, res: Response) => {
  try {
    const userPayload = (req as any).user;
    const userId = String(userPayload?.id || userPayload?.sub || '');
    const userEmail = userPayload?.email ? String(userPayload.email).toLowerCase() : '';

    if (!userId && !userEmail) {
      res.status(401).json({ error: 'Unauthorized: User identity missing' });
      return;
    }

    const query = {
      $or: [
        ...(userId ? [{ userId }] : []),
        ...(userEmail ? [{ userEmail }] : []),
      ],
    };

    const bookmarks = await bookmarkCollection.find(query).toArray();
    const bookmarkIds = bookmarks.map((b: any) => String(b.blueprintId));

    res.status(200).json({ success: true, bookmarkIds });
  } catch (error) {
    console.error('Failed to get bookmarks:', error);
    res.status(500).json({ error: 'Failed to fetch bookmarks' });
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

    // Admins have unlimited privileges without any plan limitations
    const role = String(user?.role || user?.plan || 'free').toLowerCase();
    const isAdmin = role === 'admin';

    // Soft-block check: restricted from generating blueprints (admins cannot be blocked)
    if (user?.isGenerationBlocked && !isAdmin) {
      res.status(200).json({
        role: 'restricted',
        plan: 'restricted',
        isPro: false,
        isAdmin: false,
        isBlocked: true,
        canGenerate: false,
        count: 0,
        max: 0,
        remaining: 0,
        message: 'Your blueprint generation access has been restricted by an administrator.',
      });
      return;
    }

    if (isAdmin) {
      res.status(200).json({
        role: 'admin',
        plan: 'admin',
        isPro: true,
        isAdmin: true,
        isBlocked: false,
        count: 0,
        max: 999999,
        remaining: 999999,
        canGenerate: true,
        unlimited: true,
      });
      return;
    }

    const isPro = role === 'pro';

    const hasCustomKey = Boolean(user?.customApiKey && typeof user.customApiKey === 'string' && user.customApiKey.trim().length > 0);

    if (hasCustomKey) {
      res.status(200).json({
        role: role,
        plan: role,
        isPro: isPro || isAdmin,
        isAdmin: isAdmin,
        isBlocked: false,
        count: 0,
        max: 999999,
        remaining: 999999,
        canGenerate: true,
        unlimited: true,
        hasCustomKey: true,
        apiKeyLabel: user?.apiKeyLabel || 'Custom OpenRouter Key',
      });
      return;
    }

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

// ── OpenRouter Custom API Key Management (BYOK) ──────────────────────

// Save / Update user custom OpenRouter API key (protected with verifyToken)
app.post('/api/user/api-key', verifyToken, async (req: Request, res: Response) => {
  try {
    const userPayload = (req as any).user;
    const userEmail = userPayload?.email ? String(userPayload.email).toLowerCase() : '';
    const userId = userPayload?.id || userPayload?.sub || '';

    if (!userEmail && !userId) {
      res.status(401).json({ error: 'Unauthorized: User identity missing' });
      return;
    }

    const { apiKey } = req.body;
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 10) {
      res.status(400).json({ error: 'Please provide a valid OpenRouter API key' });
      return;
    }

    const cleanKey = apiKey.trim();

    // Verify key against OpenRouter API
    try {
      const orRes = await fetch('https://openrouter.ai/api/v1/auth/key', {
        headers: {
          Authorization: `Bearer ${cleanKey}`,
        },
      });

      if (!orRes.ok) {
        if (orRes.status === 401) {
          res.status(400).json({
            error: 'Invalid OpenRouter API key. Please verify your key at openrouter.ai/keys',
          });
          return;
        }
        res.status(400).json({
          error: `OpenRouter key verification failed (Status: ${orRes.status})`,
        });
        return;
      }

      const orData = await orRes.json();
      const keyInfo = orData?.data || {};

      let userFilter: any = { email: userEmail };
      if (userId && ObjectId.isValid(userId)) {
        userFilter = { $or: [{ email: userEmail }, { _id: new ObjectId(userId) }, { _id: userId }] };
      }

      await userCollection.updateOne(userFilter, {
        $set: {
          customApiKey: cleanKey,
          apiKeyLabel: keyInfo.label || 'Custom Key',
          apiKeyCreatedAt: new Date().toISOString(),
        },
      });

      res.status(200).json({
        success: true,
        message: 'OpenRouter API key verified and connected successfully.',
        keyData: {
          label: keyInfo.label || 'Custom Key',
          usage: keyInfo.usage ?? 0,
          limit: keyInfo.limit ?? null,
          limit_remaining: keyInfo.limit_remaining ?? null,
          is_free_tier: Boolean(keyInfo.is_free_tier),
        },
      });
    } catch (fetchErr: any) {
      console.error('Failed to communicate with OpenRouter API:', fetchErr);
      res.status(502).json({
        error: 'Unable to reach OpenRouter to verify the API key. Please try again in a few moments.',
      });
    }
  } catch (err) {
    console.error('Failed to save API key:', err);
    res.status(500).json({ error: 'Internal server error while saving API key' });
  }
});

// Get user custom OpenRouter API key status & real-time balance (protected with verifyToken)
app.get('/api/user/api-key', verifyToken, async (req: Request, res: Response) => {
  try {
    const userPayload = (req as any).user;
    const userEmail = userPayload?.email ? String(userPayload.email).toLowerCase() : '';
    const userId = userPayload?.id || userPayload?.sub || '';

    if (!userEmail && !userId) {
      res.status(401).json({ error: 'Unauthorized: User identity missing' });
      return;
    }

    let userFilter: any = { email: userEmail };
    if (userId && ObjectId.isValid(userId)) {
      userFilter = { $or: [{ email: userEmail }, { _id: new ObjectId(userId) }, { _id: userId }] };
    }

    const user = await userCollection.findOne(userFilter);
    const customKey = user?.customApiKey;

    if (!customKey || typeof customKey !== 'string' || customKey.trim().length === 0) {
      res.status(200).json({ hasCustomKey: false });
      return;
    }

    const trimmedKey = customKey.trim();
    // Mask key for safety (show first 8 chars and last 4 chars)
    const maskedKey = trimmedKey.length > 14
      ? `${trimmedKey.slice(0, 8)}••••••••${trimmedKey.slice(-4)}`
      : '••••••••••••';

    // Fetch live credit / balance info from OpenRouter
    try {
      const orRes = await fetch('https://openrouter.ai/api/v1/auth/key', {
        headers: {
          Authorization: `Bearer ${trimmedKey}`,
        },
      });

      if (!orRes.ok) {
        if (orRes.status === 401) {
          res.status(200).json({
            hasCustomKey: true,
            apiKey: maskedKey,
            rawKey: trimmedKey,
            isValid: false,
            error: 'Key was revoked or expired on OpenRouter',
          });
          return;
        }
      }

      const orData = await orRes.json();
      const keyInfo = orData?.data || {};

      res.status(200).json({
        hasCustomKey: true,
        apiKey: maskedKey,
        rawKey: trimmedKey,
        label: keyInfo.label || user.apiKeyLabel || 'Custom Key',
        usage: keyInfo.usage ?? 0,
        limit: keyInfo.limit ?? null,
        limit_remaining: keyInfo.limit_remaining ?? null,
        is_free_tier: Boolean(keyInfo.is_free_tier),
        isValid: true,
      });
    } catch (fetchErr) {
      res.status(200).json({
        hasCustomKey: true,
        apiKey: maskedKey,
        rawKey: trimmedKey,
        label: user.apiKeyLabel || 'Custom Key',
        isValid: true,
      });
    }
  } catch (err) {
    console.error('Failed to get API key status:', err);
    res.status(500).json({ error: 'Internal server error checking API key status' });
  }
});

// Delete / Disconnect user custom OpenRouter API key (protected with verifyToken)
app.delete('/api/user/api-key', verifyToken, async (req: Request, res: Response) => {
  try {
    const userPayload = (req as any).user;
    const userEmail = userPayload?.email ? String(userPayload.email).toLowerCase() : '';
    const userId = userPayload?.id || userPayload?.sub || '';

    if (!userEmail && !userId) {
      res.status(401).json({ error: 'Unauthorized: User identity missing' });
      return;
    }

    let userFilter: any = { email: userEmail };
    if (userId && ObjectId.isValid(userId)) {
      userFilter = { $or: [{ email: userEmail }, { _id: new ObjectId(userId) }, { _id: userId }] };
    }

    await userCollection.updateOne(userFilter, {
      $unset: {
        customApiKey: '',
        apiKeyLabel: '',
        apiKeyCreatedAt: '',
      },
    });

    res.status(200).json({
      success: true,
      message: 'Custom OpenRouter API key removed. Returned to standard plan.',
    });
  } catch (err) {
    console.error('Failed to remove API key:', err);
    res.status(500).json({ error: 'Internal server error while removing API key' });
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
    const isAdmin = role === 'admin';

    // Soft-block check: restricted from generating blueprints (admins cannot be blocked)
    if (user?.isGenerationBlocked && !isAdmin) {
      res.status(403).json({
        error: 'Your blueprint generation access has been restricted by an administrator. Please contact support.',
        isBlocked: true,
      });
      return;
    }

    const isPro = role === 'pro' || isAdmin;
    const hasCustomKey = Boolean(user?.customApiKey && typeof user.customApiKey === 'string' && user.customApiKey.trim().length > 0);

    // Enforce quotas (skipped if admin OR if user has connected their own OpenRouter API key)
    if (!isAdmin && !hasCustomKey) {
      if (role === 'pro') {
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
      } else {
        const lifetimeCount = await blueprintCollection.countDocuments({
          $or: [{ creatorId: userId }, { author: userEmail }, { email: userEmail }],
        });

        if (lifetimeCount >= 3) {
          res.status(403).json({
            error: 'Free tier generation limit reached (3/3). Upgrade to Pro for unlimited generations.',
            limitReached: true,
            role: 'free',
            count: lifetimeCount,
            max: 3,
          });
          return;
        }
      }
    }

    if (isPro) {
      // Pro can be private or public
      blueprint.visibility = blueprint.visibility === 'private' ? 'private' : 'public';
    } else {
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
      const safeSearch = escapeRegex(search);
      query = {
        $and: [
          ownershipCondition,
          {
            $or: [
              { title: { $regex: safeSearch, $options: 'i' } },
              { description: { $regex: safeSearch, $options: 'i' } },
              { prompt: { $regex: safeSearch, $options: 'i' } },
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

// ─── ADMIN ENDPOINTS ───────────────────────────────────────────────────────

// Get all users with MongoDB search, filter, and pagination
app.get('/api/admin/users', verifyToken, verifyAdmin, async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit || '10'), 10)));
    const search = String(req.query.search || '').trim();
    const role = String(req.query.role || '').trim().toLowerCase();
    const status = String(req.query.status || '').trim().toLowerCase();

    const andConditions: any[] = [];

    if (search) {
      const safeSearch = escapeRegex(search);
      andConditions.push({
        $or: [
          { name: { $regex: safeSearch, $options: 'i' } },
          { email: { $regex: safeSearch, $options: 'i' } },
        ],
      });
    }

    if (role && role !== 'all') {
      andConditions.push({
        $or: [{ role }, { plan: role }],
      });
    }

    if (status && status !== 'all') {
      if (status === 'blocked') {
        andConditions.push({ isGenerationBlocked: true });
      } else if (status === 'active') {
        andConditions.push({ isGenerationBlocked: { $ne: true } });
      }
    }

    const query = andConditions.length > 0 ? (andConditions.length > 1 ? { $and: andConditions } : andConditions[0]) : {};

    const total = await userCollection.countDocuments(query);
    const totalPages = Math.ceil(total / limit) || 1;

    const users = await userCollection
      .find(query, { projection: { password: 0, customApiKey: 0 } })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();

    // Map blueprint counts per author / email
    const userEmails = users.map((u: any) => String(u.email || '').toLowerCase()).filter(Boolean);
    const blueprintCounts = await blueprintCollection
      .aggregate([
        { $match: { author: { $in: userEmails } } },
        { $group: { _id: '$author', count: { $sum: 1 } } },
      ])
      .toArray();

    const countMap = new Map<string, number>();
    blueprintCounts.forEach((b: any) => {
      if (b._id) countMap.set(String(b._id).toLowerCase(), b.count);
    });

    const mappedUsers = users.map((u: any) => {
      const email = String(u.email || '').toLowerCase();
      return {
        _id: String(u._id),
        name: u.name || 'Anonymous User',
        email: u.email,
        image: u.image || null,
        role: String(u.role || u.plan || 'free').toLowerCase(),
        plan: String(u.plan || u.role || 'free').toLowerCase(),
        isGenerationBlocked: Boolean(u.isGenerationBlocked),
        blueprintCount: countMap.get(email) || 0,
        createdAt: u.createdAt || null,
      };
    });

    const [freeUsers, proUsers, blockedUsers, totalBlueprints] = await Promise.all([
      userCollection.countDocuments({
        $or: [{ role: 'free' }, { role: 'user' }, { plan: 'free' }],
      }),
      userCollection.countDocuments({
        $or: [{ role: 'pro' }, { plan: 'pro' }],
      }),
      userCollection.countDocuments({ isGenerationBlocked: true }),
      blueprintCollection.countDocuments(),
    ]);

    res.status(200).json({
      success: true,
      users: mappedUsers,
      total,
      totalPages,
      page,
      limit,
      stats: {
        freeUsers,
        proUsers,
        blockedUsers,
        totalBlueprints,
      },
    });
  } catch (error) {
    console.error('Failed to fetch admin users:', error);
    res.status(500).json({ error: 'Failed to fetch user list' });
  }
});

// Soft-block toggle for blueprint generation
app.patch('/api/admin/users/:id/block', verifyToken, verifyAdmin, async (req: Request, res: Response) => {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : String(rawId || '');
    const { isBlocked } = req.body;

    if (typeof isBlocked !== 'boolean') {
      res.status(400).json({ error: 'isBlocked boolean is required in request body' });
      return;
    }

    const filter: any = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { $or: [{ _id: id }, { id }] };
    const targetUser = await userCollection.findOne(filter);
    if (!targetUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Protect administrator accounts from being blocked
    if (targetUser.role === 'admin' && isBlocked) {
      res.status(400).json({ error: 'Cannot block administrator accounts' });
      return;
    }

    await userCollection.updateOne(filter, {
      $set: {
        isGenerationBlocked: isBlocked,
        updatedAt: new Date().toISOString(),
      },
    });

    res.status(200).json({
      success: true,
      userId: id,
      isGenerationBlocked: isBlocked,
      message: isBlocked ? 'User blueprint generation has been blocked' : 'User blueprint generation has been unblocked',
    });
  } catch (error) {
    console.error('Failed to update user block status:', error);
    res.status(500).json({ error: 'Failed to update user block status' });
  }
});

// User role toggle (Free ↔ Pro or User ↔ Admin)
app.patch('/api/admin/users/:id/role', verifyToken, verifyAdmin, async (req: Request, res: Response) => {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : String(rawId || '');
    const { role } = req.body;

    const targetRole = String(role || '').toLowerCase();
    if (!['admin', 'user', 'free', 'pro'].includes(targetRole)) {
      res.status(400).json({ error: 'Role must be admin, user, free, or pro' });
      return;
    }

    const filter: any = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { $or: [{ _id: id }, { id }] };
    const targetUser = await userCollection.findOne(filter);
    if (!targetUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Protect administrator from demoting themselves
    const caller = (req as any).adminUser;
    const isCallerSelf = caller && (
      String(caller._id) === String(targetUser._id) ||
      String(caller.email || '').toLowerCase() === String(targetUser.email || '').toLowerCase()
    );
    if (isCallerSelf && targetRole !== 'admin') {
      res.status(400).json({ error: 'You cannot remove your own administrator privileges' });
      return;
    }

    const updateFields: any = {
      role: targetRole,
      updatedAt: new Date().toISOString(),
    };

    if (['free', 'pro'].includes(targetRole)) {
      updateFields.plan = targetRole;
    }

    await userCollection.updateOne(filter, {
      $set: updateFields,
    });

    res.status(200).json({
      success: true,
      userId: id,
      role: targetRole,
      message: targetRole === 'admin'
        ? 'User has been promoted to Administrator'
        : targetRole === 'user'
          ? 'Administrator privileges have been revoked'
          : `User plan updated to ${targetRole.toUpperCase()}`,
    });
  } catch (error) {
    console.error('Failed to update user role:', error);
    res.status(500).json({ error: 'Failed to update user role' });
  }
});

// Get all transaction history with search, filters, and pagination
app.get('/api/admin/transactions', verifyToken, verifyAdmin, async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit || '10'), 10)));
    const search = String(req.query.search || '').trim();
    const plan = String(req.query.plan || '').trim().toLowerCase();
    const timeframe = String(req.query.timeframe || '').trim().toLowerCase();

    const andConditions: any[] = [];

    if (search) {
      const safeSearch = escapeRegex(search);
      andConditions.push({
        $or: [
          { userEmail: { $regex: safeSearch, $options: 'i' } },
          { transactionId: { $regex: safeSearch, $options: 'i' } },
          { planName: { $regex: safeSearch, $options: 'i' } },
        ],
      });
    }

    if (plan && plan !== 'all') {
      const safePlan = escapeRegex(plan);
      andConditions.push({
        $or: [
          { planName: { $regex: safePlan, $options: 'i' } },
          { plan: { $regex: safePlan, $options: 'i' } },
        ],
      });
    }

    if (timeframe && timeframe !== 'all') {
      let sinceDate: Date | null = null;
      if (timeframe === 'today' || timeframe === '24h') {
        sinceDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      } else if (timeframe === '7d') {
        sinceDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      } else if (timeframe === '30d') {
        sinceDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      }

      if (sinceDate) {
        andConditions.push({
          $or: [
            { createdAt: { $gte: sinceDate } },
            { createdAt: { $gte: sinceDate.toISOString() } },
          ],
        });
      }
    }

    const query = andConditions.length > 0 ? { $and: andConditions } : {};

    const total = await transactionCollection.countDocuments(query);
    const totalPages = Math.ceil(total / limit) || 1;

    const transactions = await transactionCollection
      .find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();

    const mappedTransactions = transactions.map((t: any) => ({
      _id: String(t._id),
      transactionId: t.transactionId || 'N/A',
      userEmail: t.userEmail || 'unknown',
      amount: Number(t.amount) || 0,
      currency: t.currency || 'USD',
      planName: t.planName || 'Archflow Pro Subscription',
      createdAt: t.createdAt || null,
    }));

    const revenueAgg = await transactionCollection
      .aggregate([
        { $group: { _id: null, totalAmount: { $sum: '$amount' } } },
      ])
      .toArray();
    const totalAmount = revenueAgg[0]?.totalAmount || 0;

    res.status(200).json({
      success: true,
      transactions: mappedTransactions,
      total,
      totalPages,
      page,
      limit,
      stats: {
        totalAmount: Math.round(totalAmount * 100) / 100,
      },
    });
  } catch (error) {
    console.error('Failed to fetch transactions:', error);
    res.status(500).json({ error: 'Failed to fetch transaction history' });
  }
});

// Get all blueprints with search, visibility filter, and pagination
app.get('/api/admin/blueprints', verifyToken, verifyAdmin, async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit || '10'), 10)));
    const search = String(req.query.search || '').trim();
    const visibility = String(req.query.visibility || '').trim().toLowerCase();

    const andConditions: any[] = [];

    if (search) {
      const safeSearch = escapeRegex(search);
      andConditions.push({
        $or: [
          { title: { $regex: safeSearch, $options: 'i' } },
          { author: { $regex: safeSearch, $options: 'i' } },
          { email: { $regex: safeSearch, $options: 'i' } },
          { description: { $regex: safeSearch, $options: 'i' } },
        ],
      });
    }

    if (visibility && visibility !== 'all') {
      andConditions.push({ visibility });
    }

    const query = andConditions.length > 0 ? (andConditions.length > 1 ? { $and: andConditions } : andConditions[0]) : {};

    const total = await blueprintCollection.countDocuments(query);
    const totalPages = Math.ceil(total / limit) || 1;

    const blueprints = await blueprintCollection
      .find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();

    const mappedBlueprints = blueprints.map((b: any) => ({
      _id: String(b._id),
      title: b.title || 'Untitled Blueprint',
      description: b.description || '',
      author: b.author || b.email || 'Anonymous',
      email: b.email || b.author || '',
      visibility: b.visibility || 'public',
      rating: Number(b.rating) || 0,
      ratingsCount: Number(b.ratingsCount) || 0,
      views: Number(b.views) || 0,
      downloads: Number(b.downloads) || 0,
      complexity: b.complexity || b.complexcity || 'Medium',
      teckStack: Array.isArray(b.teckStack)
        ? b.teckStack
        : (typeof b.teckStack === 'string'
          ? b.teckStack.split(',').map((s: string) => s.trim())
          : []),
      createdAt: b.createdAt || null,
    }));

    res.status(200).json({
      success: true,
      blueprints: mappedBlueprints,
      total,
      totalPages,
      page,
      limit,
    });
  } catch (error) {
    console.error('Failed to fetch admin blueprints:', error);
    res.status(500).json({ error: 'Failed to fetch blueprints' });
  }
});

// Admin toggle blueprint visibility (public / private)
app.patch('/api/admin/blueprints/:id/visibility', verifyToken, verifyAdmin, async (req: Request, res: Response) => {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : String(rawId || '');
    const { visibility } = req.body;

    if (!['public', 'private'].includes(String(visibility).toLowerCase())) {
      res.status(400).json({ error: 'Visibility must be either public or private' });
      return;
    }

    const filter: any = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { $or: [{ _id: id }, { id }] };
    const result = await blueprintCollection.updateOne(filter, {
      $set: {
        visibility: String(visibility).toLowerCase(),
        updatedAt: new Date().toISOString(),
      },
    });

    if (result.matchedCount === 0) {
      res.status(404).json({ error: 'Blueprint not found' });
      return;
    }

    res.status(200).json({
      success: true,
      blueprintId: id,
      visibility,
      message: `Blueprint visibility updated to ${visibility}`,
    });
  } catch (error) {
    console.error('Failed to update blueprint visibility:', error);
    res.status(500).json({ error: 'Failed to update blueprint visibility' });
  }
});

// Admin delete blueprint (purge)
app.delete('/api/admin/blueprints/:id', verifyToken, verifyAdmin, async (req: Request, res: Response) => {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : String(rawId || '');

    const filter: any = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { $or: [{ _id: id }, { id }] };
    const result = await blueprintCollection.deleteOne(filter);

    if (result.deletedCount === 0) {
      res.status(404).json({ error: 'Blueprint not found' });
      return;
    }

    res.status(200).json({
      success: true,
      blueprintId: id,
      message: 'Blueprint permanently deleted',
    });
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
