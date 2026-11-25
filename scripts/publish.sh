#!/bin/zsh
# Publish opencode-annotate-it to npm.
#
# Prerequisites:
#   - npm account with 2FA enabled (security key / passkey is fine)
#   - a granular access token with read/write packages scope saved in
#     ~/.npm-publish-token (chmod 600)
#
# npm asks for a one-time browser confirmation (passkey) on publish.
# This script runs npm under a pseudo-TTY so npm waits for the confirmation,
# opens the browser itself, and completes the publish after you approve.
set -u
cd "$(dirname "$0")/.." || exit 1
printf '\n' | script -q /tmp/opencode-annotate-it-publish.txt \
  npm publish --access public --//registry.npmjs.org/:_authToken=$(cat "$HOME/.npm-publish-token")
STATUS=$?
tail -5 /tmp/opencode-annotate-it-publish.txt
exit $STATUS