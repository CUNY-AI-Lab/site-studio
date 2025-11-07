#!/usr/bin/env bash
set -e

# Development server launcher with proper signal handling
# This script ensures clean shutdown of all child processes

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Store PIDs for cleanup
BACKEND_PID=""
FRONTEND_PID=""
CLEANUP_DONE=false

# Cleanup function - called on script exit
cleanup() {
  # Prevent multiple cleanup calls
  if [ "$CLEANUP_DONE" = true ]; then
    return
  fi
  CLEANUP_DONE=true

  echo ""
  echo -e "${YELLOW}🛑 Shutting down dev servers...${NC}"

  # Kill backend
  if [ -n "$BACKEND_PID" ] && ps -p "$BACKEND_PID" > /dev/null 2>&1; then
    echo -e "${BLUE}  Stopping backend (PID $BACKEND_PID)...${NC}"
    kill "$BACKEND_PID" 2>/dev/null || true
    # Wait up to 5 seconds for graceful shutdown
    for i in {1..10}; do
      if ! ps -p "$BACKEND_PID" > /dev/null 2>&1; then
        break
      fi
      sleep 0.5
    done
    # Force kill if still running
    if ps -p "$BACKEND_PID" > /dev/null 2>&1; then
      echo -e "${RED}  Force killing backend...${NC}"
      kill -9 "$BACKEND_PID" 2>/dev/null || true
    fi
  fi

  # Kill frontend
  if [ -n "$FRONTEND_PID" ] && ps -p "$FRONTEND_PID" > /dev/null 2>&1; then
    echo -e "${BLUE}  Stopping frontend (PID $FRONTEND_PID)...${NC}"
    kill "$FRONTEND_PID" 2>/dev/null || true
    # Wait up to 5 seconds for graceful shutdown
    for i in {1..10}; do
      if ! ps -p "$FRONTEND_PID" > /dev/null 2>&1; then
        break
      fi
      sleep 0.5
    done
    # Force kill if still running
    if ps -p "$FRONTEND_PID" > /dev/null 2>&1; then
      echo -e "${RED}  Force killing frontend...${NC}"
      kill -9 "$FRONTEND_PID" 2>/dev/null || true
    fi
  fi

  # Wait for all background jobs
  wait 2>/dev/null || true

  echo -e "${GREEN}✓ All servers stopped${NC}"
  exit 0
}

# Register cleanup on various exit conditions
trap cleanup EXIT INT TERM

# Check if ports are already in use
check_port() {
  local port=$1
  if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
    return 0  # Port is in use
  else
    return 1  # Port is free
  fi
}

echo -e "${BLUE}🚀 Starting Site Studio development servers...${NC}"
echo ""

# Check for port conflicts
if check_port 3001; then
  echo -e "${RED}✗ Port 3001 is already in use!${NC}"
  echo -e "${YELLOW}  Run './scripts/cleanup-ports.sh' to clean up orphan processes${NC}"
  exit 1
fi

if check_port 5173; then
  echo -e "${RED}✗ Port 5173 is already in use!${NC}"
  echo -e "${YELLOW}  Run './scripts/cleanup-ports.sh' to clean up orphan processes${NC}"
  exit 1
fi

# Start backend
echo -e "${BLUE}📦 Starting backend...${NC}"
cd packages/backend
npm run dev > ../../backend.log 2>&1 &
BACKEND_PID=$!
cd ../..

# Wait for backend to be ready (check port 3001)
echo -e "${YELLOW}  Waiting for backend on port 3001...${NC}"
WAIT_COUNT=0
MAX_WAIT=60  # 30 seconds (60 * 0.5s)

while ! check_port 3001; do
  if ! ps -p "$BACKEND_PID" > /dev/null 2>&1; then
    echo -e "${RED}✗ Backend process died during startup${NC}"
    echo -e "${YELLOW}  Check backend.log for errors${NC}"
    tail -n 20 backend.log
    exit 1
  fi

  WAIT_COUNT=$((WAIT_COUNT + 1))
  if [ $WAIT_COUNT -ge $MAX_WAIT ]; then
    echo -e "${RED}✗ Backend failed to start within 30 seconds${NC}"
    echo -e "${YELLOW}  Check backend.log for errors${NC}"
    tail -n 20 backend.log
    exit 1
  fi

  sleep 0.5
done

echo -e "${GREEN}  ✓ Backend ready (PID $BACKEND_PID)${NC}"

# Start frontend
echo -e "${BLUE}🎨 Starting frontend...${NC}"
cd packages/frontend
npm run dev > ../../frontend.log 2>&1 &
FRONTEND_PID=$!
cd ../..

# Wait for frontend to be ready (check port 5173)
echo -e "${YELLOW}  Waiting for frontend on port 5173...${NC}"
WAIT_COUNT=0

while ! check_port 5173; do
  if ! ps -p "$FRONTEND_PID" > /dev/null 2>&1; then
    echo -e "${RED}✗ Frontend process died during startup${NC}"
    echo -e "${YELLOW}  Check frontend.log for errors${NC}"
    tail -n 20 frontend.log
    exit 1
  fi

  WAIT_COUNT=$((WAIT_COUNT + 1))
  if [ $WAIT_COUNT -ge $MAX_WAIT ]; then
    echo -e "${RED}✗ Frontend failed to start within 30 seconds${NC}"
    echo -e "${YELLOW}  Check frontend.log for errors${NC}"
    tail -n 20 frontend.log
    exit 1
  fi

  sleep 0.5
done

echo -e "${GREEN}  ✓ Frontend ready (PID $FRONTEND_PID)${NC}"
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✓ Development servers are running:${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  ${BLUE}Backend:${NC}  http://localhost:3001 ${YELLOW}(PID $BACKEND_PID)${NC}"
echo -e "  ${BLUE}Frontend:${NC} http://localhost:5173 ${YELLOW}(PID $FRONTEND_PID)${NC}"
echo ""
echo -e "  ${BLUE}Logs:${NC}"
echo -e "    Backend:  ${YELLOW}backend.log${NC}"
echo -e "    Frontend: ${YELLOW}frontend.log${NC}"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop all servers${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Wait for user interrupt or process death
while true; do
  # Check if either process has died
  if ! ps -p "$BACKEND_PID" > /dev/null 2>&1; then
    echo -e "${RED}✗ Backend process died unexpectedly${NC}"
    echo -e "${YELLOW}  Last 20 lines of backend.log:${NC}"
    tail -n 20 backend.log
    exit 1
  fi

  if ! ps -p "$FRONTEND_PID" > /dev/null 2>&1; then
    echo -e "${RED}✗ Frontend process died unexpectedly${NC}"
    echo -e "${YELLOW}  Last 20 lines of frontend.log:${NC}"
    tail -n 20 frontend.log
    exit 1
  fi

  # Sleep briefly before next check
  sleep 1
done
