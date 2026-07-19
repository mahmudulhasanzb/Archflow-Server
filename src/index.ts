import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { MongoClient, Db, ObjectId } from 'mongodb';
import { createRemoteJWKSet, jwtVerify } from 'jose-cjs';

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

// JWT JWKS Verification helper using jose-cjs
const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
const JWKS = createRemoteJWKSet(new URL(`${clientUrl}/api/auth/jwks`));

// Auth Request interface
export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role?: string;
    [key: string]: any;
  };
}

// Authentication Middleware
export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  let token = '';

  // 1. Read from Authorization Header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }

  // 2. Read from Cookies
  if (!token && req.headers.cookie) {
    const cookies = req.headers.cookie.split(';').reduce((acc: any, cur: string) => {
      const parts = cur.split('=');
      if (parts[0]) {
        acc[parts[0].trim()] = parts[1]?.trim();
      }
      return acc;
    }, {});
    token = cookies['better-auth.session_token'] || cookies['session_token'] || '';
  }

  if (!token) {
    return res.status(401).json({ msg: 'Unauthorized: No token provided' });
  }

  // 3. Hardcoded bypass for Demo Mode
  if (token === 'demo-session-token') {
    req.user = {
      id: 'demo-user',
      email: 'demo@archflow.com',
      role: 'user'
    };
    return next();
  }

  // 4. Verify token using JWKS public keys
  try {
    const { payload } = await jwtVerify(token, JWKS);
    req.user = {
      id: (payload.sub || payload.id) as string,
      email: payload.email as string,
      role: (payload.role || 'user') as string,
      ...payload
    };
    return next();
  } catch (error: any) {
    // 5. Database fallback check if JWKS fails (e.g. offline or raw DB sessions)
    if (db) {
      try {
        const sessionDoc = await db.collection('session').findOne({ token });
        if (sessionDoc) {
          const userDoc = await db.collection('user').findOne({ _id: new ObjectId(sessionDoc.userId) });
          if (userDoc) {
            req.user = {
              id: userDoc._id.toString(),
              email: userDoc.email,
              role: userDoc.role || 'user'
            };
            return next();
          }
        }
      } catch (dbErr) {
        console.error('Session verification database error:', dbErr);
      }
    }
    
    console.error('JWT JWKS validation failed:', error.message);
    return res.status(401).json({ msg: 'Unauthorized' });
  }
}

// API Health Check
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    database: db ? 'mongodb' : 'memory'
  });
});

// Protected Profile Endpoint
app.get('/api/auth/me', authMiddleware as any, (req: AuthRequest, res: Response) => {
  res.json({ user: req.user });
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
