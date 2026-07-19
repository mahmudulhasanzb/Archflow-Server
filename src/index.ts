import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { MongoClient, Db, ObjectId } from 'mongodb';
import { jwtVerify } from 'jose-cjs';

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

// JWT Verification helper using jose-cjs
async function verifyJWT(token: string) {
  const secretKey = process.env.JWT_SECRET || 'zXv2IGCUk0pXzaQ5ejPy6zGw4bQpeEHA';
  const secret = new TextEncoder().encode(secretKey);
  try {
    const { payload } = await jwtVerify(token, secret);
    return payload;
  } catch (err) {
    return null;
  }
}

// Auth Request interface
export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role?: string;
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
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  // 3. Verify JWT using jose-cjs
  const jwtPayload = await verifyJWT(token);
  if (jwtPayload) {
    req.user = {
      id: (jwtPayload.sub || jwtPayload.id) as string,
      email: jwtPayload.email as string,
      role: (jwtPayload.role || 'user') as string
    };
    return next();
  }

  // 4. Verify better-auth session from database
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
    } catch (err) {
      console.error('Session verification database error:', err);
    }
  }

  // 5. Hardcoded bypass for Demo Mode
  if (token === 'demo-session-token') {
    req.user = {
      id: 'demo-user',
      email: 'demo@archflow.com',
      role: 'user'
    };
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized: Invalid token' });
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
