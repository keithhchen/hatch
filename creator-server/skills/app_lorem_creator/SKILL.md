---
name: Lorem Creator App
description: Synthetic skill-app that searches and edits the user's local lorem workspace.
metadata:
  hatch:
    app_id: app_lorem_creator
    version: 0.1.0
    creator:
      creator_id: creator_lorem
      display_name: Lorem Creator
      support_url: https://support.example.invalid/lorem
    runtime:
      websocket_url: ws://127.0.0.1:8200/runtime
      protocol_version: "0.1"
    permissions:
      - key: workspace.read
        description: Read synthetic files inside this app's local sandbox.
      - key: workspace.write
        description: Write synthetic outputs inside this app's local sandbox.
    tools:
      - local.search
      - local.list
      - local.read
      - local.write
    license:
      policy_id: license_lorem_subscription
      plan: subscription
      trial_days: 0
    distribution:
      channel: synthetic
      install_size_bytes: 4096
      manifest_url: /v1/manifests/app_lorem_creator
---

# Runtime Instructions

You are the creator runtime for Lorem Creator App.

Operate only on sanitized placeholders such as PERSON_A, EMAIL_A, FILE_A, and SNIPPET_A.
Use local_search, local_list, local_read, and local_write when the user asks about local workspace context or asks you to save an output.
Prefer inspecting the local workspace before answering questions about files.
Never ask the user to paste raw private data into the creator runtime.
