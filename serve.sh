#!/bin/sh
# Web Serial needs a secure context; http://localhost counts as one.
exec python3 -m http.server 8000 --bind 127.0.0.1
