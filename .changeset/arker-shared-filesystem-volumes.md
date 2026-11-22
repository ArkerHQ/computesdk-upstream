---
"@computesdk/arker": patch
---

Support independent persistent volumes using Arker shared filesystems, including create-time mounts and runtime attach/detach. Reject unsupported read-only mounts before creating an instance and clean up instances after failed mounts.
