#!/bin/sh
# gitp's askpass. git and ssh run it with a prompt as $1 when they need a
# username, a password or a key passphrase, or ssh wants an unknown host key
# confirmed. It asks in a native dialog and prints the answer; Cancel exits
# non-zero, which git and ssh take as no answer. gitp rewrites this file at
# startup, so edits don't last.
#
# The prompt reaches AppleScript as an argument, never spliced into the
# script's source: part of it comes from the remote.
case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
  *'(yes/no'*) mode=confirm ;;
  *password* | *passphrase* | *token*) mode=hidden ;;
  *) mode=text ;;
esac
exec osascript -e '
on run argv
	set {theText, theMode} to argv
	activate
	if theMode is "confirm" then
		display dialog theText with title "gitp" with icon caution buttons {"Cancel", "Connect"} default button "Connect" cancel button "Cancel"
		return "yes"
	else if theMode is "hidden" then
		return text returned of (display dialog theText with title "gitp" default answer "" with hidden answer)
	else
		return text returned of (display dialog theText with title "gitp" default answer "")
	end if
end run' -- "$1" "$mode"
