# Commerce ledger persistence

`CommerceLedger` can be in-memory or backed by a JSONL file. A file-backed
ledger is intended for the current single-host deployment, where Dashboard and
Runtime mount the same local Docker volume and use the same ledger path.

Every mutation acquires an atomic `<ledger>.lock` directory, reloads and
validates the latest committed snapshot, applies idempotency and event-chain
checks, then commits through a same-directory temporary file, file `fsync`,
atomic rename, and directory `fsync`. Reads reload the atomic snapshot so an
already-running process observes commits made by the other process.

## Recovery and operating boundary

Locks are deliberately never guessed stale or auto-stolen. If a writer exits
after acquiring the lock, later mutations fail with `ledger_lock_timeout`.
Stop every Dashboard and Runtime process that can write this ledger, verify no
writer remains, remove the `<ledger>.lock` directory, and then restart them.
Same-directory `.<ledger>.<pid>.<uuid>.tmp` files left by a terminated writer
are not committed and may be removed only while all writers are stopped.

This implementation assumes one host and a local filesystem with atomic
same-directory rename and exclusive directory creation. It does not claim safe
coordination over NFS, object-backed mounts, multiple hosts, or mixed old/new
writer versions. It serializes all writes and rewrites the validated snapshot,
so a database transaction should replace it before high-volume or multi-host
operation. All writer containers must also have compatible ownership and
permissions on the shared volume.
