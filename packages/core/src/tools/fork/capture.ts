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

export const captureFeature: ForkFeature = {
  name: 'capture',
  definitions: [CAPTURE_VIEWS],
  handlers: {
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
`,
};
