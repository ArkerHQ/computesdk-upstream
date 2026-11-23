---
"@computesdk/arker": patch
---

Honor instance timeouts with server-side scheduled-delete policies set atomically during creation, including snapshot restores. Reject invalid lifetimes before creating a VM. Snapshot handles do not inherit the adapter's source-instance deadline.
