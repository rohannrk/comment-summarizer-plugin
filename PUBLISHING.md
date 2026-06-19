# Figma Community listing: Comment Summarizer

Copy and paste this into the publish form (Plugins, then Development, then your plugin, then Publish). Edit anything in `<angle brackets>` before you submit.

---

## Name
Comment Summarizer

## Tagline (100 characters max)
Summarize Figma comments into a clear recap and action list with your own AI key.

## Description

Reading through a pile of comment threads is slow. Select a frame, a section, or nothing for the whole page, and this plugin reads the comments for you and writes a short report.

Each report has three parts: a quick summary of the discussion, who was involved and what they wanted, and a checklist of the tasks that came out of it with an owner and status.

Bring your own AI key. Paste a Google Gemini key, or point it at a local model running in Ollama or LM Studio. You pick the model and only pay for your own usage.

You can check how many comments are in scope before running, skip resolved threads, copy the result as Markdown, or drop it onto the canvas as a text frame.

To set up, create a Figma access token with the file_comments:read scope, add your AI key, and paste the file URL. Your token and key stay on your machine and only go to Figma and the model you chose.

## Tags
comments, summary, ai, productivity, feedback, design review, tasks, documentation, workflow, notes

## Category
Workflow and Productivity

---

## Why the plugin needs network access

For the reviewers, and for anyone curious. The plugin only ever talks to two kinds of places.

It calls `https://api.figma.com` to read the file's comments and to check that the access token is valid. This is necessary because the regular Plugin API cannot read comments at all, only the REST API can.

It calls `https://generativelanguage.googleapis.com` to send the comment text to Google Gemini for summarizing, using the key the user supplied.

If the user chooses a local model instead, requests go only to the address they set up themselves, such as `http://localhost:11434`.

There is no analytics, there are no servers run by the author, and the plugin collects nothing. Credentials live in Figma's local storage on the user's own device.

## Privacy note (worth including in the listing)

Comment Summarizer sends the text of the comments you choose to summarize to whichever AI provider you pick, either Google Gemini or a local model. It does not send your designs, your layers, or anything else from the file. Your Figma token and AI key stay on your machine and are never shared with the plugin author. If you work with sensitive material, have a look at your AI provider's data policy first.

---

## Before you submit

Run `npm run build:prod` and re-import the plugin so the published version is the minified build rather than the development one.

Check that `allowedDomains` in `manifest.json` lists only the endpoints you actually use.

Add a plugin icon at 128 by 128 pixels.

Add cover art, ideally around 1920 by 960 pixels.

Test against a real file. Try comments pinned to layers, comments floating on the canvas, and resolved comments. Try the whole page with nothing selected. And try the error cases, like a bad token or the wrong file URL.

Make sure the description is clear that you need to bring your own AI key. Reviewers tend to reject plugins that surprise people with a key requirement.

## Ideas for the icon and cover

For the icon, a speech bubble with a few short list lines inside it reads nicely, on a solid Figma blue background.

For the cover, you could put a cluster of overlapping comment pins on the left and a clean card on the right showing the Summary, People, and Action items sections, with the tagline running across the top.
