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
APP_PID=""
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

  # Kill app
  if [ -n "$APP_PID" ] && ps -p "$APP_PID" > /dev/null 2>&1; then
    echo -e "${BLUE}  Stopping app (PID $APP_PID)...${NC}"
    kill "$APP_PID" 2>/dev/null || true
    # Wait up to 5 seconds for graceful shutdown
    for i in {1..10}; do
      if ! ps -p "$APP_PID" > /dev/null 2>&1; then
        break
      fi
      sleep 0.5
    done
    # Force kill if still running
    if ps -p "$APP_PID" > /dev/null 2>&1; then
      echo -e "${RED}  Force killing app...${NC}"
      kill -9 "$APP_PID" 2>/dev/null || true
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
if check_port 8792; then
  echo -e "${RED}✗ Port 8792 is already in use!${NC}"
  echo -e "${YELLOW}  Run './scripts/cleanup-ports.sh' to clean up orphan processes${NC}"
  exit 1
fi

if check_port 5173; then
  echo -e "${RED}✗ Port 5173 is already in use!${NC}"
  echo -e "${YELLOW}  Run './scripts/cleanup-ports.sh' to clean up orphan processes${NC}"
  exit 1
fi

# Start app
echo -e "${BLUE}📦 Starting app...${NC}"
cd packages/app
npm run dev > ../../app.log 2>&1 &
APP_PID=$!
cd ../..

# Wait for app to be ready (check port 8792)
echo -e "${YELLOW}  Waiting for app on port 8792...${NC}"
WAIT_COUNT=0
MAX_WAIT=60  # 30 seconds (60 * 0.5s)

while ! check_port 8792; do
  if ! ps -p "$APP_PID" > /dev/null 2>&1; then
    echo -e "${RED}✗ App process died during startup${NC}"
    echo -e "${YELLOW}  Check app.log for errors${NC}"
    tail -n 20 app.log
    exit 1
  fi

  WAIT_COUNT=$((WAIT_COUNT + 1))
  if [ $WAIT_COUNT -ge $MAX_WAIT ]; then
    echo -e "${RED}✗ App failed to start within 30 seconds${NC}"
    echo -e "${YELLOW}  Check app.log for errors${NC}"
    tail -n 20 app.log
    exit 1
  fi

  sleep 0.5
done

echo -e "${GREEN}  ✓ App ready (PID $APP_PID)${NC}"

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
echo -e "  ${BLUE}App:${NC}      http://localhost:8792 ${YELLOW}(PID $APP_PID)${NC}"
echo -e "  ${BLUE}Frontend:${NC} http://localhost:5173 ${YELLOW}(PID $FRONTEND_PID)${NC}"
echo ""
echo -e "  ${BLUE}Logs:${NC}"
echo -e "    App:      ${YELLOW}app.log${NC}"
echo -e "    Frontend: ${YELLOW}frontend.log${NC}"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop all servers${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Wait for user interrupt or process death
while true; do
  # Check if either process has died
  if ! ps -p "$APP_PID" > /dev/null 2>&1; then
    echo -e "${RED}✗ App process died unexpectedly${NC}"
    echo -e "${YELLOW}  Last 20 lines of app.log:${NC}"
    tail -n 20 app.log
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
