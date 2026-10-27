# Avatar preparation

## Prepare the chosen image

- Generation: follow the confirmed reference and appearance. Keep a specified character recognizable and match the requested version. Without a style preference, use illustration.
- Recommend a single 512 x 512 or 1024 x 1024 square image: a centered face or symbol, key features inside the central circular area, and a simple background. Avoid text, watermarks and decorative borders. These are generation recommendations, not upload requirements.
- Supplied image: use the user's file. Non-square images are supported; Rovai handles avatar framing.
- Online source: follow the user's reference and download a suitable image file.

## Validate and submit

1. Check file access, format and import limits in `rovai member create --help` before preparing a preview or creation input. Use PNG/JPEG by default; GIF only when supplied or explicitly requested. Use a smaller file if over budget; automatic GIF compression is unavailable.
2. For generated images, check that the subject matches the plan and remains recognizable at avatar size.
3. Pass the readable local image path to `--avatar-file`; no specific directory is required.

Submit GIF animation intact. One avatar file is enough; separate portraits, icons and channel images are unnecessary.
