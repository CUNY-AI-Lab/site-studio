#!/usr/bin/env bash

# Cleanup script for orphaned dev server processes
# Kills any processes listening on development ports

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🧹 Cleaning up orphan development server processes...${NC}"
echo ""

# Function to kill processes on a specific port
kill_port() {
  local port=$1
  local name=$2

  echo -e "${BLUE}Checking port $port ($name)...${NC}"

  # Find PIDs using the port
  local pids=$(lsof -ti:$port 2>/dev/null || true)

  if [ -z "$pids" ]; then
    echo -e "${GREEN}  ✓ No processes found on port $port${NC}"
    return 0
  fi

  echo -e "${YELLOW}  Found processes: $pids${NC}"

  # Try graceful kill first (SIGTERM)
  echo -e "${BLUE}  Attempting graceful shutdown (SIGTERM)...${NC}"
  for pid in $pids; do
    if ps -p $pid > /dev/null 2>&1; then
      kill $pid 2>/dev/null || true
    fi
  done

  # Wait up to 5 seconds for processes to exit
  for i in {1..10}; do
    local remaining=$(lsof -ti:$port 2>/dev/null || true)
    if [ -z "$remaining" ]; then
      echo -e "${GREEN}  ✓ Port $port cleaned up successfully${NC}"
      return 0
    fi
    sleep 0.5
  done

  # Force kill if still running (SIGKILL)
  local remaining=$(lsof -ti:$port 2>/dev/null || true)
  if [ -n "$remaining" ]; then
    echo -e "${YELLOW}  Processes still running, force killing (SIGKILL)...${NC}"
    for pid in $remaining; do
      if ps -p $pid > /dev/null 2>&1; then
        kill -9 $pid 2>/dev/null || true
      fi
    done
    sleep 1

    # Final check
    local final_check=$(lsof -ti:$port 2>/dev/null || true)
    if [ -z "$final_check" ]; then
      echo -e "${GREEN}  ✓ Port $port cleaned up (force killed)${NC}"
    else
      echo -e "${RED}  ✗ Failed to clean up port $port${NC}"
      return 1
    fi
  fi
}

# Clean up app port (8792)
kill_port 8792 "App"
echo ""

# Clean up frontend port (5173)
kill_port 5173 "Frontend"
echo ""

# Also check for any stray npm/node processes related to site-studio
echo -e "${BLUE}Checking for other site-studio processes...${NC}"
orphans=$(ps aux | grep -E "(npm|node).*(site-studio|packages/(app|frontend))" | grep -v grep | grep -v "cleanup-ports" | awk '{print $2}' || true)

if [ -n "$orphans" ]; then
  echo -e "${YELLOW}  Found additional processes: $orphans${NC}"
  echo -e "${BLUE}  Cleaning up...${NC}"
  for pid in $orphans; do
    if ps -p $pid > /dev/null 2>&1; then
      kill $pid 2>/dev/null || true
    fi
  done
  sleep 1
  echo -e "${GREEN}  ✓ Additional processes cleaned up${NC}"
else
  echo -e "${GREEN}  ✓ No additional orphan processes found${NC}"
fi

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✓ Cleanup complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BLUE}You can now start dev servers with:${NC} ./dev.sh"
echo ""
