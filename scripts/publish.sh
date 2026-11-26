#!/bin/zsh
# Publish opencode-annotate-it to npm.
#
# Prerequisites:
#   - npm account with 2FA enabled (security key / passkey is fine)
#   - a granular access token with read/write packages scope saved in
#     ~/.npm-publish-token (chmod 600)
#
# npm asks for a one-time browser confirmation (passkey) on publish.
# npm only waits for that confirmation in interactive mode, so we run it
# under a pseudo-TTY, open the confirmation URL ourselves as soon as it
# appears, and let npm complete the publish after approval.
set -u
cd "$(dirname "$0")/.." || exit 1
LOG=/tmp/opencode-annotate-it-publish.txt
rm -f "$LOG"
script -q "$LOG" npm publish --access public --//registry.npmjs.org/:_authToken=$(cat "$HOME/.npm-publish-token") &
NPM_PID=$!
URL=""
for i in $(seq 1 60); do
  URL=$(LC_ALL=C cat "$LOG" 2>/dev/null | tr -d '\000-\010\013\014\016-\037\177' | sed 's/\[[0-9;]*[A-Za-z]//g' | grep -o 'https://www.npmjs.com/auth/cli/[a-f0-9-]*' | head -1)
  [ -n "$URL" ] && break
  sleep 0.5
done
if [ -n "$URL" ]; then
  echo "Подтвердите публикацию: $URL"
  open "$URL"
else
  echo "Не нашёл ссылку подтверждения; вывод npm:"
  tail -20 "$LOG"
fi
wait $NPM_PID
STATUS=$?
tail -5 "$LOG"
exit $STATUS