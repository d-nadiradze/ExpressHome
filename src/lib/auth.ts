import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { db } from "./db";

const SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || "fallback-secret-change-in-production"
);

const SESSION_DURATION = parseInt(process.env.SESSION_DURATION || "86400", 10);
const COOKIE_NAME = "myhome_session";

export interface SessionPayload {
  userId: string;
  sessionId: string;
  email: string;
  role: string;
}

// Create a signed JWT token
export async function signToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DURATION}s`)
    .sign(SECRET);
}

// Verify a JWT token
export async function verifyToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET);
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

// Create or replace the user's active session (one per user)
export async function createSession(
  userId: string,
  email: string,
  role: string
): Promise<string> {
  const expiresAt = new Date(Date.now() + SESSION_DURATION * 1000);

  // Delete existing session (enforce single active session)
  await db.session.deleteMany({ where: { userId } });

  // Create new session record (token will be set after signing)
  const sessionRecord = await db.session.create({
    data: {
      userId,
      token: "pending", // placeholder
      expiresAt,
    },
  });

  const token = await signToken({
    userId,
    sessionId: sessionRecord.id,
    email,
    role,
  });

  // Update with real token
  await db.session.update({
    where: { id: sessionRecord.id },
    data: { token },
  });

  return token;
}

// Set the session cookie
export async function setSessionCookie(token: string) {
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_DURATION,
    path: "/",
  });
}

// Clear the session cookie
export async function clearSessionCookie() {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}

// Get the current session from the cookie
export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;

  const payload = await verifyToken(token);
  if (!payload) return null;

  // Verify session exists in DB and is not expired
  const session = await db.session.findUnique({
    where: { token },
  });

  if (!session || session.expiresAt < new Date()) {
    return null;
  }

  return payload;
}

// Delete a session from the DB
export async function deleteSession(userId: string) {
  await db.session.deleteMany({ where: { userId } });
}

// Get full user from session
export async function getCurrentUser() {
  const session = await getSession();
  if (!session) return null;

  return db.user.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      createdAt: true,
      myhomeAccount: {
        select: {
          myhomeEmail: true,
          isVerified: true,
          lastLoginAt: true,
        },
      },
    },
  });
}
