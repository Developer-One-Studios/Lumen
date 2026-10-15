import type { ToolDefinition } from '../definitions.js';
import type { ForkFeature } from './feature.js';

const point = (description: string) => ({ type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description });

// Camera placement runs generated Luau, so it lives here as a write tool and capture_screenshot stays read-only.
const CAPTURE_VIEWS: ToolDefinition = {
  name: 'capture_views',
  category: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  description: 'Use to screenshot the viewport from chosen camera positions, in edit or on playtest clients, camera restored after.',
  inputSchema: {
    type: 'object',
    properties: {
      views: {
        type: 'array',
        minItems: 1,
        maxItems: 8,
        items: {
          type: 'object',
          properties: {
            camera_position: point('Camera [x, y, z].'),
            look_at: point('Point [x, y, z] it faces.'),
            label: { type: 'string', description: 'Name reported with this image.' },
          },
          required: ['camera_position'],
        },
        description: 'Camera placements shot in order.',
      },
      clients: {
        anyOf: [
          { type: 'string', enum: ['all'] },
          { type: 'array', items: { type: 'string' } },
        ],
        description: '"all" or client roles or instance ids, views shot on each.',
      },
      max_width: { type: 'integer', minimum: 64, description: 'Downscale frames wider than this, keeping the aspect ratio.' },
      format: { type: 'string', enum: ['jpeg', 'png'], description: 'Image format, default jpeg.' },
      quality: { type: 'number', description: 'JPEG quality 1-100, default 92.' },
      instance_id: { type: 'string', description: 'Studio process ID when ambiguous.' },
    },
    required: ['views'],
  },
};

// Reads the Studio window, not the place, but draws corner markers in the viewport while it locates it.
const RECORD_VIEWPORT: ToolDefinition = {
  name: 'record_viewport',
  category: 'read',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  description: 'Use to record the viewport for a few seconds and see timestamped frames, to judge motion, timing and transitions.',
  inputSchema: {
    type: 'object',
    properties: {
      duration_s: { type: 'number', minimum: 0.5, maximum: 30, default: 5, description: 'Seconds to record, 0.5 to 30.' },
      fps: { type: 'integer', minimum: 1, maximum: 30, default: 15, description: 'Frames per second to grab, 1 to 30.' },
      frame_width: { type: 'integer', minimum: 64, maximum: 1280, default: 480, description: 'Width of each saved frame in pixels.' },
      sheet_frames: { type: 'integer', minimum: 1, maximum: 48, default: 24, description: 'Frames shown in the returned grid, evenly spaced.' },
      save_frames: { type: 'boolean', default: true, description: 'Save every frame as a PNG in the artifact folder.' },
      instance_id: { type: 'string', description: 'Studio process ID when ambiguous.' },
    },
  },
};

export const captureFeature: ForkFeature = {
  name: 'capture',
  definitions: [CAPTURE_VIEWS, RECORD_VIEWPORT],
  handlers: {
    record_viewport: async (tools, body) => tools.fork.serializeCapture(() => tools.recordViewport(body.instance_id as string | undefined, body)),
    capture_views: async (tools, body) => {
      if (body.views === undefined) throw new Error('views is required, for example [{"camera_position": [0, 50, 0], "look_at": [0, 0, 0]}]');
      return tools.fork.serializeCapture(() => tools.captureScreenshot(
        body.instance_id as string | undefined,
        body.format as string | undefined,
        body.quality as number | undefined,
        { max_width: body.max_width, views: body.views, clients: body.clients },
      ));
    },
  },
  instructions: [
    {
      tools: ['capture_screenshot', 'simulate_mouse_input'],
      text: 'A capture_screenshot shrunk by max_width reports scale, so multiply image coordinates by it before simulate_mouse_input.',
    },
    {
      tools: ['capture_views'],
      text: 'Use capture_views to shoot from given camera positions, since capture_screenshot never moves the camera.',
    },
    {
      tools: ['record_viewport'],
      text: 'Use record_viewport to see motion over time, such as a cutscene, a transition or an effect, which a single screenshot cannot show.',
    },
  ],
  guide: `## Screenshots and camera views

- capture_screenshot shoots the viewport that input tools target: the selected or first playtest client during a playtest, otherwise the edit viewport.
- capture_screenshot never moves the camera, and capture_views does: it takes up to 8 views of camera_position with optional look_at and label and shoots them in order.
- capture_views moves the edit camera in edit mode and the client camera during a playtest, and puts it back once after the last view, also when a shot fails.
- During a playtest the client camera is switched to Scriptable and pinned to the view every frame until the restore, which gives back its CameraType and CFrame so a Custom camera follows the character again.
- An image entry with a warning was shot after the camera drifted off the view, usually because a game script moves the camera too, so do not trust what it shows.
- A camera restore that failed shows up in warnings, and the next capture_views on that peer still restores the camera it saved first.
- max_width shrinks wider frames before encoding by averaging pixels, which keeps thin lines and text readable and saves tokens.
- Every capture reports width, height, originalWidth and originalHeight, and a downscaled one also reports scale.
- simulate_mouse_input and inspect_gui work in original viewport pixels, so multiply coordinates read off a downscaled image by scale.x and scale.y.
- clients takes "all" or a list of client roles or instance ids and captures each client's own Studio window, which a multiplayer playtest opens per player.
- With views or clients the first text block lists every image with its label, client, instance_id and sizes, and images[].image gives its position among the image blocks.
- Pass an entry's instance_id to simulate_mouse_input to click in that client's window.
- One call returns at most 12 images, which share an 8 MB inline budget with at most 6 MB each.
- JPEG quality drops on busy frames to fit that budget, and a PNG over its share is refused, so use max_width when shooting several views.
- With StreamingEnabled a client only has the parts streamed in around its character, so a distant client camera view can look empty while the edit view shows the parts.
- Captures are serialized against each other, but other tools that move the camera at the same time still end up in the shot.

## Recording the viewport

- record_viewport grabs the viewport that input tools target fps times a second for duration_s and returns a grid of evenly spaced frames, each labelled with its seconds since the start, plus timing in JSON.
- Start it right after triggering what you want to watch, for example in the same turn as the input or eval call that starts a cutscene. startedAtUnixMs lines frames up with log timestamps, which are Unix seconds.
- Every frame is saved as a PNG in the artifact folder unless save_frames is false, named with its milliseconds since the start, so a moment the grid skipped can be read on its own.
- It reads the Studio window through the host OS: the X server on Linux, a few milliseconds per frame, and the host capture helper on Windows and macOS, where each frame takes much longer and the frame rate is low.
- Studio has to be on screen but may sit behind other windows. A minimized Studio window has no pixels, so the call fails and asks for it to be restored.
- Studio only draws so fast, often about 15 frames a second when it is not focused. distinctFrames and newFramesPerSecond show how many grabs held a new frame, and repeated frames mean Studio drew slower than fps.
- Like the host capture fallback, it shows corner markers in the viewport for one frame to locate it, then hides them before recording.
`,
};
