import fs from "fs/promises";
import dotenv from "dotenv";
import { spawn } from "child_process";

dotenv.config();

const INPUT_FILE = "./video-prime.json";
const OUTPUT_FILE = "./video-prime-wistia.json";

const WISTIA_TOKEN = "14f927d7f9dbdee2b2dbd6b5cfa0e39dd0f1dd824aa36b5159754637a84de876";
const WISTIA_PROJECT_ID = "sy5bjgimn3";

if (!WISTIA_TOKEN) {
  console.error("Missing WISTIA_TOKEN in .env");
  process.exit(1);
}

if (!WISTIA_PROJECT_ID) {
  console.error("Missing WISTIA_PROJECT_ID in .env");
  process.exit(1);
}

/*
 * ------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------
 */

const FFMPEG = "ffmpeg";
const CURL = "curl";

const DELAY_BETWEEN_VIDEOS = 500;

// false = choose the highest quality from the Wistia master playlist
// true  = always request 1080p if available
const PREFER_1080P = true;

/*
 * ------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFilename(name) {
  return String(name)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .trim()
    .slice(0, 180);
}

function buildMasterUrl(sourceId) {
  return `https://fast.wistia.com/embed/medias/${sourceId}.m3u8`;
}

/*
 * ------------------------------------------------------------
 * Check FFmpeg
 * ------------------------------------------------------------
 */

async function checkCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "ignore"],
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} is not available`));
      }
    });
  });
}

/*
 * ------------------------------------------------------------
 * Download master playlist
 * ------------------------------------------------------------
 */

async function getMasterPlaylist(sourceId) {
  const url = buildMasterUrl(sourceId);

  console.log(`Fetching master playlist:`);
  console.log(`  ${url}`);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Could not fetch master playlist: HTTP ${response.status}`);
  }

  const text = await response.text();

  if (!text.includes("#EXTM3U")) {
    throw new Error("Response is not a valid HLS playlist");
  }

  return {
    url,
    text,
  };
}

/*
 * ------------------------------------------------------------
 * Parse Wistia HLS master playlist
 * ------------------------------------------------------------
 */

function parseVariants(masterUrl, playlist) {
  const lines = playlist
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const variants = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!line.startsWith("#EXT-X-STREAM-INF:")) {
      continue;
    }

    const attributes = line.substring("#EXT-X-STREAM-INF:".length);

    const bandwidthMatch = attributes.match(/(?:^|,)BANDWIDTH=(\d+)/);
    const averageBandwidthMatch = attributes.match(
      /(?:^|,)AVERAGE_BANDWIDTH=(\d+)/,
    );
    const resolutionMatch = attributes.match(/(?:^|,)RESOLUTION=(\d+)x(\d+)/);
    const nameMatch = attributes.match(/(?:^|,)NAME="([^"]+)"/);

    const nextLine = lines[i + 1];

    if (!nextLine || nextLine.startsWith("#")) {
      continue;
    }

    const absoluteUrl = new URL(nextLine, masterUrl).toString();

    variants.push({
      url: absoluteUrl,

      bandwidth: bandwidthMatch ? Number(bandwidthMatch[1]) : 0,

      averageBandwidth: averageBandwidthMatch
        ? Number(averageBandwidthMatch[1])
        : 0,

      width: resolutionMatch ? Number(resolutionMatch[1]) : 0,

      height: resolutionMatch ? Number(resolutionMatch[2]) : 0,

      name: nameMatch ? nameMatch[1] : `${resolutionMatch?.[2] || "unknown"}p`,
    });
  }

  if (variants.length === 0) {
    throw new Error("No HLS variants found in master playlist");
  }

  variants.sort((a, b) => {
    if (a.height !== b.height) {
      return b.height - a.height;
    }

    return b.bandwidth - a.bandwidth;
  });

  return variants;
}

/*
 * ------------------------------------------------------------
 * Select quality
 * ------------------------------------------------------------
 */

function chooseVariant(variants) {
  if (PREFER_1080P) {
    const preferred = variants.find((v) => v.height === 1080);

    if (preferred) {
      return preferred;
    }
  }

  return variants[0];
}

/*
 * ------------------------------------------------------------
 * Test FFmpeg input
 * ------------------------------------------------------------
 */

async function testHls(sourceUrl) {
  return new Promise((resolve, reject) => {
    console.log(`Testing HLS stream...`);

    const ffmpeg = spawn(
      FFMPEG,
      [
        "-hide_banner",
        "-loglevel",
        "error",

        "-i",
        sourceUrl,

        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",

        "-t",
        "3",

        "-f",
        "null",

        "-",
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );

    let stderr = "";

    ffmpeg.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    ffmpeg.on("error", reject);

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        console.log("HLS stream OK");
        resolve();
      } else {
        reject(new Error(`FFmpeg could not read the HLS stream:\n${stderr}`));
      }
    });
  });
}

/*
 * ------------------------------------------------------------
 * Stream HLS → MP4 → Wistia
 *
 * Important:
 *
 * Nothing is written to disk.
 *
 * FFmpeg stdout:
 *
 *      ↓
 *
 * curl stdin:
 *
 *      ↓
 *
 * Wistia
 * ------------------------------------------------------------
 */

async function uploadHlsToWistia({ sourceUrl, name, sourceId }) {
  return new Promise((resolve, reject) => {
    console.log("");
    console.log("Starting streaming upload...");
    console.log(`Source: ${sourceUrl}`);
    console.log(`Name:   ${name}`);

    /*
     * FFmpeg:
     *
     * -i source.m3u8
     *
     * -c:v copy
     * -c:a copy
     *
     * means:
     *
     * DO NOT re-encode the video.
     *
     * This is extremely important for your laptop.
     *
     * FFmpeg only repackages the HLS stream into MP4.
     *
     * If the source codecs are compatible with MP4,
     * this is basically a remux rather than a full
     * video conversion.
     */

    const ffmpeg = spawn(
      FFMPEG,
      [
        "-hide_banner",
        "-loglevel",
        "warning",

        "-i",
        sourceUrl,

        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",

        "-c:v",
        "copy",

        "-c:a",
        "copy",

        "-bsf:a",
        "aac_adtstoasc",

        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",

        "-f",
        "mp4",

        "pipe:1",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    /*
     * curl receives FFmpeg's stdout.
     *
     * @-
     *
     * means:
     *
     * read the uploaded file from stdin.
     */

    const curl = spawn(
      CURL,
      [
        "--fail",
        "--silent",
        "--show-error",

        "-X",
        "POST",

        "https://upload.wistia.com/",

        "-H",
        `Authorization: Bearer ${WISTIA_TOKEN}`,

        "-H",
        "Accept: application/json",

        /*
         * Send the MP4 stream as a multipart
         * file named video.mp4.
         */

        "-F",
        "file=@-;filename=video.mp4;type=video/mp4",

        "-F",
        `project_id=${WISTIA_PROJECT_ID}`,

        "-F",
        `name=${name}`,

        "-F",
        "low_priority=true",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    /*
     * FFmpeg stdout → curl stdin
     */

    ffmpeg.stdout.pipe(curl.stdin);

    let curlStdout = "";
    let curlStderr = "";
    let ffmpegStderr = "";

    curl.stdout.on("data", (chunk) => {
      curlStdout += chunk.toString();
    });

    curl.stderr.on("data", (chunk) => {
      curlStderr += chunk.toString();
    });

    ffmpeg.stderr.on("data", (chunk) => {
      ffmpegStderr += chunk.toString();
    });

    let ffmpegCode = null;
    let curlCode = null;

    let finished = false;

    function fail(error) {
      if (finished) return;

      finished = true;

      try {
        ffmpeg.kill("SIGTERM");
      } catch {}

      try {
        curl.kill("SIGTERM");
      } catch {}

      reject(error);
    }

    function finish() {
      if (finished) return;

      if (ffmpegCode === null || curlCode === null) {
        return;
      }

      finished = true;

      if (ffmpegCode !== 0) {
        reject(
          new Error(`FFmpeg failed with code ${ffmpegCode}\n${ffmpegStderr}`),
        );

        return;
      }

      if (curlCode !== 0) {
        reject(
          new Error(
            `Wistia upload failed with curl code ${curlCode}\n${curlStderr}`,
          ),
        );

        return;
      }

      let data;

      try {
        data = JSON.parse(curlStdout);
      } catch {
        reject(new Error(`Wistia returned invalid JSON:\n${curlStdout}`));

        return;
      }

      if (!data.hashed_id) {
        reject(
          new Error(
            `Wistia upload succeeded but no hashed_id was returned:\n${JSON.stringify(
              data,
              null,
              2,
            )}`,
          ),
        );

        return;
      }

      console.log("");
      console.log("WISTIA UPLOAD SUCCESS");
      console.log(`Hashed ID: ${data.hashed_id}`);

      resolve({
        hashed_id: data.hashed_id,

        wistia_url: `https://fast.wistia.net/embed/medias/${data.hashed_id}`,

        source_id: sourceId,

        source_url: sourceUrl,

        raw_response: data,
      });
    }

    ffmpeg.on("error", (error) => {
      fail(new Error(`Could not start FFmpeg: ${error.message}`));
    });

    curl.on("error", (error) => {
      fail(new Error(`Could not start curl: ${error.message}`));
    });

    ffmpeg.on("close", (code) => {
      ffmpegCode = code;

      /*
       * If curl dies early, stop FFmpeg.
       */

      if (curlCode !== null && curlCode !== 0) {
        try {
          ffmpeg.kill("SIGTERM");
        } catch {}
      }

      finish();
    });

    curl.on("close", (code) => {
      curlCode = code;

      /*
       * If Wistia rejects the upload, stop FFmpeg
       * instead of continuing to download the video.
       */

      if (code !== 0) {
        try {
          ffmpeg.kill("SIGTERM");
        } catch {}
      }

      finish();
    });

    /*
     * If curl closes stdin while FFmpeg is still
     * producing data, stop FFmpeg.
     */

    curl.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") {
        fail(error);
      }
    });
  });
}

/*
 * ------------------------------------------------------------
 * Import one video
 * ------------------------------------------------------------
 */

async function importVideo(video) {
  const sourceId = video.sourceId;

  const master = await getMasterPlaylist(sourceId);

  const variants = parseVariants(master.url, master.text);

  console.log("");
  console.log("Available qualities:");

  for (const variant of variants) {
    console.log(
      `  ${variant.name} ${variant.width}x${variant.height} ` +
        `${Math.round(variant.bandwidth / 1000)} kbps`,
    );
  }

  const selected = chooseVariant(variants);

  console.log("");
  console.log(`Selected: ${selected.name}`);
  console.log(`Stream:   ${selected.url}`);

  /*
   * Make sure FFmpeg can actually read it before
   * starting the long Wistia upload.
   */

  await testHls(selected.url);

  return uploadHlsToWistia({
    sourceUrl: selected.url,
    name: video.name,
    sourceId,
  });
}

/*
 * ------------------------------------------------------------
 * Main
 * ------------------------------------------------------------
 */

async function main() {
  console.log("==========================================");
  console.log(" WISTIA HLS → MP4 STREAMING IMPORTER");
  console.log("==========================================");
  console.log("");

  console.log("Checking dependencies...");

  try {
    await checkCommand(FFMPEG, ["-version"]);
  } catch {
    console.error("");
    console.error("FFmpeg is not installed.");
    console.error("");
    console.error("Install it with:");
    console.error("  sudo pacman -S ffmpeg");
    console.error("");

    process.exit(1);
  }

  try {
    await checkCommand(CURL, ["--version"]);
  } catch {
    console.error("curl is not installed.");
    process.exit(1);
  }

  console.log("FFmpeg: OK");
  console.log("curl:   OK");
  console.log("");

  /*
   * Read input
   */

  const raw = await fs.readFile(INPUT_FILE, "utf8");

  const data = JSON.parse(raw);

  /*
   * If output already exists, resume from it.
   *
   * This is important because you have many videos.
   */

  let outputData;

  try {
    const existing = await fs.readFile(OUTPUT_FILE, "utf8");

    outputData = JSON.parse(existing);

    console.log(`Resuming from existing ${OUTPUT_FILE}`);
  } catch {
    outputData = structuredClone(data);

    /*
     * Create initial output file.
     */

    await fs.writeFile(
      OUTPUT_FILE,
      JSON.stringify(outputData, null, 2),
      "utf8",
    );
  }

  let total = 0;
  let imported = 0;
  let failed = 0;
  let skipped = 0;

  for (const category of outputData.learningPath) {
    console.log("");
    console.log(`========== ${category.category} ==========`);

    for (const video of category.learningPath) {
      if (video.type !== "ivideo") {
        continue;
      }

      if (!video.sourceId) {
        console.log(`Skipping ${video.name}: no sourceId`);

        skipped++;
        continue;
      }

      total++;

      /*
       * Already imported?
       */

      if (video.wistia_url && video.wistia_hashed_id) {
        console.log("");
        console.log(`Already imported: ${video.name}`);

        skipped++;
        continue;
      }

      console.log("");
      console.log(`------------------------------------------`);
      console.log(`Video ${total}: ${video.name}`);
      console.log(`Source ID: ${video.sourceId}`);
      console.log(`------------------------------------------`);

      try {
        const result = await importVideo(video);

        video.wistia_url = result.wistia_url;

        video.wistia_hashed_id = result.hashed_id;

        video.wistia_source_url = result.source_url;

        video.wistia_imported_at = new Date().toISOString();

        imported++;

        /*
         * SAVE IMMEDIATELY.
         */

        await fs.writeFile(
          OUTPUT_FILE,
          JSON.stringify(outputData, null, 2),
          "utf8",
        );

        console.log("");
        console.log(`Saved to ${OUTPUT_FILE}`);
        console.log(`Wistia URL: ${result.wistia_url}`);
      } catch (error) {
        failed++;

        console.error("");
        console.error(`FAILED: ${video.name}`);

        console.error(error?.message || error);

        /*
         * Record failure but continue.
         */

        video.wistia_import_error = error?.message || String(error);

        video.wistia_import_failed_at = new Date().toISOString();

        await fs.writeFile(
          OUTPUT_FILE,
          JSON.stringify(outputData, null, 2),
          "utf8",
        );
      }

      /*
       * Give the system a little breathing room.
       */

      await sleep(DELAY_BETWEEN_VIDEOS);
    }
  }

  console.log("");
  console.log("==========================================");
  console.log(" IMPORT COMPLETE");
  console.log("==========================================");

  console.log(`Total:    ${total}`);
  console.log(`Imported: ${imported}`);
  console.log(`Failed:   ${failed}`);
  console.log(`Skipped:  ${skipped}`);

  console.log("");
  console.log(`Output: ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error("");
  console.error("==========================================");
  console.error(" FATAL ERROR");
  console.error("==========================================");
  console.error(error);
  process.exit(1);
});
