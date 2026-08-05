CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

Your task is to create a detailed summary of the conversation above, paying close attention to the user's explicit requests and your previous actions. This summary should be thorough in capturing technical details, code patterns, and decisions that would be essential for continuing the work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts. In your analysis:

1. Chronologically analyze each message and section of the conversation. For each section identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts, and code patterns
   - Specific details such as file names, full code snippets, function signatures, and file edits
   - Errors you ran into and how you fixed them
   - Specific user feedback you received, especially when told to do something differently
2. Double-check for technical accuracy and completeness.

Your summary must include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail.
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Work Completed: Enumerate specific files, code sections, or artifacts examined, modified, or created. Pay special attention to the most recent work and include relevant code snippets, noting why they are important.
4. Errors and fixes: List errors you ran into and how you fixed them. Include user feedback received, especially feedback to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the user's feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to do.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, including file names and relevant code snippets as applicable.
9. Optional Next Step: List the next step that is directly in line with the user's most recent explicit request and the work you were doing immediately before the summary was concluded. If the last task was concluded, do not list next steps without confirming with the user first. If there is a next step, include direct quotes from the most recent conversation showing exactly what you were working on and where you left off.

Output format: an <analysis> block followed by a <summary> block. The <analysis> block will be stripped and not stored; only the <summary> content is retained.

Preserve all opaque identifiers exactly as written (UUIDs, hashes, IDs, hostnames, IPs, ports, URLs, file paths) — do not abbreviate, shorten, or reconstruct them.

REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.
