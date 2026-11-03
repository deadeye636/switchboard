#!/bin/bash
# measure-git-worktree.sh — how `git worktree` behaves in the cases a worktree service must handle (#804, #805,
# spec 41 "Measurements", T1 question 6). Git Bash on Windows; it builds throwaway repos in a sandbox and deletes the
# sandbox at the end. Usage: bash scripts/measure-git-worktree.sh [sandbox]  (default: the demo sandbox root + /t1-git-probe).
# Prints each command, its output and its exit code. Changes no git config; commits use a throwaway identity.
S="${1:-/c/temp/switchboard/t1-git-probe}"
case "$S" in */t1-git-probe) ;; *) echo "sandbox must end in /t1-git-probe"; exit 2;; esac
mkdir -p $S && cd $S || exit 1
export GIT_AUTHOR_NAME=probe GIT_AUTHOR_EMAIL=probe@example.invalid GIT_COMMITTER_NAME=probe GIT_COMMITTER_EMAIL=probe@example.invalid
run(){ echo "\$ $*"; "$@" 2>&1 | sed 's/^/  | /'; echo "  -> exit=${PIPESTATUS[0]}"; }
ci(){ git commit -qm "$1"; }
mk(){ git init -q -b main "$1"; (cd "$1"; echo a>a.txt; git add .; ci init); }
echo "=== a) normal"
mk repo; cd repo
run git worktree add ../wt-x -b task/x
run git worktree list --porcelain
run git worktree remove ../wt-x
run git worktree add ../wt-y -b task/y
echo dirty >> ../wt-y/a.txt; echo u > ../wt-y/untracked.txt
run git worktree remove ../wt-y
run git worktree remove --force ../wt-y
run git worktree add ../wt-z -b task/z
echo u > ../wt-z/untracked.txt
run git worktree remove ../wt-z
run git worktree remove --force ../wt-z
run git worktree add ../wt-p -b task/p
rm -rf ../wt-p
run git worktree list --porcelain
run git worktree prune -v
run git worktree list
run git branch --list
run git branch -d task/x
run git branch -D task/p
echo "=== a2) locked"
run git worktree add ../wt-l -b task/l
run git worktree lock ../wt-l --reason probe
run git worktree remove ../wt-l
run git worktree remove -f -f ../wt-l
echo "=== b) submodule"
cd $S; mk sub; mk super; cd super
run git -c protocol.file.allow=always submodule add $S/sub libsub
ci addsub
run git worktree add ../wt-sub -b task/sub
run ls -A ../wt-sub/libsub
run git -C ../wt-sub submodule status
run git -C ../wt-sub submodule update --init
run git -C ../wt-sub -c protocol.file.allow=always submodule update --init
run ls -A ../wt-sub/libsub
run cat ../wt-sub/libsub/.git
run git worktree remove ../wt-sub
run git worktree remove --force ../wt-sub
echo "=== c) bare"
cd $S; run git clone -q --bare repo bare.git; cd bare.git
run git rev-parse --is-bare-repository --is-inside-work-tree
run git worktree add ../wt-bare -b task/bare
run git worktree list --porcelain
run cat ../wt-bare/.git
run git -C ../wt-bare rev-parse --is-inside-work-tree --show-toplevel --git-common-dir
run git worktree remove ../wt-bare
echo "=== d) detached"
cd $S/repo; git checkout -q --detach HEAD
run git rev-parse --abbrev-ref HEAD
run git worktree add ../wt-d1 -b task/d1
run git worktree add --detach ../wt-d2
run git worktree list --porcelain
run git worktree remove ../wt-d1; run git worktree remove ../wt-d2
git checkout -q main
echo "=== e) dirty main"
echo mod >> a.txt; echo n > newfile.txt
run git worktree add ../wt-e -b task/e
run ls -A ../wt-e
run git -C ../wt-e status --porcelain
run git status --porcelain
run git worktree remove ../wt-e
git checkout -q -- a.txt; rm newfile.txt
echo "=== f) same branch twice"
run git worktree add ../wt-f -b task/f
run git worktree add ../wt-f2 task/f
run git worktree add ../wt-f3 main
run git worktree add ../wt-f4 -b task/f
run git worktree add ../wt-f
run git worktree remove ../wt-f
echo "=== g) spaces + long path"
run git config --show-origin core.longpaths
run git worktree add "../wt with spaces" -b task/space
run git worktree list
run git worktree remove "../wt with spaces"
LONG=$S/$(printf 'd%.0s' {1..60})/$(printf 'e%.0s' {1..60})/$(printf 'f%.0s' {1..60})/$(printf 'g%.0s' {1..60})
mkdir -p "$LONG"
H=$(printf 'h%.0s' {1..40})
mkdir -p deepdir/$H; echo x > deepdir/$H/file.txt; git add .; ci deep
WT="$LONG/wt-long"; echo "len(wt path win)=$(cygpath -w "$WT" | wc -c)  len(deepest file)=$(cygpath -w "$WT/deepdir/$H/file.txt" | wc -c)"
run git worktree add "$WT" -b task/long
run git -C "$WT" status --porcelain
run ls "$WT/deepdir"
run git worktree remove "$WT"
echo "-- with core.longpaths=false"
run git -c core.longpaths=false worktree add "$WT" -b task/long2
run git -c core.longpaths=false worktree remove --force "$WT"
run git worktree prune -v
run git worktree list
echo "=== h) not a repo"
mkdir -p $S/plain; cd $S/plain
run git rev-parse --is-inside-work-tree
run git worktree add ../wt-h -b task/h
echo "=== i) timing"
cd $S/repo
for n in 1 2 3; do s=$(date +%s%N); git worktree add -q ../wt-t$n -b task/t$n; e=$(date +%s%N); echo "add $n: $(( (e-s)/1000000 )) ms"; done
for n in 1 2 3; do s=$(date +%s%N); git worktree remove ../wt-t$n; e=$(date +%s%N); echo "remove $n: $(( (e-s)/1000000 )) ms"; done
echo "=== g2) length threshold for the worktree path"
for L in 200 210 220 225 228 230; do
  base=$S/q; mkdir -p "$S/q"; pad=$(( L - $(printf %s "$(cygpath -w "$base/")" | wc -c) ))
  P="$base/$(printf 'x%.0s' $(seq 1 $pad))"
  out=$(git worktree add -q "$P" -b task/len$L 2>&1); rc=$?
  echo "wt path len $(printf %s "$(cygpath -w "$P")" | wc -c): exit=$rc $out"
  [ $rc -eq 0 ] && git worktree remove --force "$P"
done
cd / && rm -rf "$S" && echo "sandbox removed: $S"
