export interface User {
  id: string;
  email?: string;
  createdAt: Date;
}

export interface UserSession {
  userId: string;
  sessionId: string;
  projectId: string;
  createdAt: Date;
  lastActivity: Date;
}

export interface AuthenticatedRequest {
  user: User;
}
