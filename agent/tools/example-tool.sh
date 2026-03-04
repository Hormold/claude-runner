#!/bin/bash
# example-tool.sh — Example tool that the agent can execute
#
# Usage: ./tools/example-tool.sh <name>
# Returns: A greeting message
#
# Replace this with your own tools: DB queries, API calls, file processing, etc.

NAME="${1:-World}"
echo "Hello, $NAME! This is an example tool."
echo "Replace this script with tools for your use case."
