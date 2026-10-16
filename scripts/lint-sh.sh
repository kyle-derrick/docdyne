#!/bin/bash
err=0
for f in /mnt/d/data/code/git/own/DocDyne/scripts/*.sh; do
  out=$(bash -n "$f" 2>&1) || { echo "SYNTAX_FAIL: $f: $out"; err=1; }
done
[ $err -eq 0 ] && echo SYNTAX_ALL_OK
