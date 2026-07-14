#!/bin/sh
set -eu

state_directory="${CHAT_CONTEXT_STATE_DIR:-/var/lib/chat-context}"
install -d -o node -g node -m 0700 "$state_directory"
chown -R node:node "$state_directory"
exec gosu node "$@"
