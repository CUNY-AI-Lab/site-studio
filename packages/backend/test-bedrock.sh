#!/bin/bash

# Test script for Bedrock integration
# This creates a test project and sends a simple query to the agent

echo "=== Testing Bedrock Integration ==="
echo ""

# Step 1: Create a test project
echo "1. Creating test project..."
RESPONSE=$(curl -s -c /tmp/site-studio-cookies.txt \
  -X POST http://localhost:3001/api/projects \
  -H "Content-Type: application/json" \
  -d '{"name":"bedrock-test","template":"blank"}')

echo "Response: $RESPONSE"
PROJECT_ID=$(echo $RESPONSE | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

if [ -z "$PROJECT_ID" ]; then
  echo "❌ Failed to create project"
  exit 1
fi

echo "✅ Project created: $PROJECT_ID"
echo ""

# Step 2: Send a test query to the agent
echo "2. Testing agent with simple query..."
echo "Query: 'Hello! Can you tell me what you can do?'"
echo ""
echo "Agent response:"
echo "---"

timeout 30 curl -s -b /tmp/site-studio-cookies.txt \
  -X POST http://localhost:3001/api/query \
  -H "Content-Type: application/json" \
  -d "{\"prompt\":\"Hello! Can you tell me what you can do?\",\"projectId\":\"$PROJECT_ID\",\"mode\":\"execute\"}" \
  2>&1 | while IFS= read -r line; do
    if [[ $line == data:* ]]; then
      # Extract and parse the JSON after "data: "
      json_data="${line#data: }"
      if [[ $json_data != "[DONE]" ]]; then
        # Try to extract text content from assistant messages
        text=$(echo "$json_data" | grep -o '"text":"[^"]*"' | sed 's/"text":"\(.*\)"/\1/' | sed 's/\\n/\n/g')
        if [ ! -z "$text" ]; then
          echo "$text"
        fi
        # Check for errors
        error=$(echo "$json_data" | grep -o '"error":"[^"]*"' | sed 's/"error":"\(.*\)"/\1/')
        if [ ! -z "$error" ]; then
          echo "❌ Error: $error"
        fi
      fi
    fi
  done

EXIT_CODE=$?
echo ""
echo "---"

if [ $EXIT_CODE -eq 124 ]; then
  echo "⚠️  Query timed out after 30 seconds (this might be normal for first request)"
elif [ $EXIT_CODE -ne 0 ]; then
  echo "❌ Query failed with exit code: $EXIT_CODE"
else
  echo "✅ Query completed"
fi

# Cleanup
rm -f /tmp/site-studio-cookies.txt

echo ""
echo "=== Test Complete ==="
