import BridgeCore

let serverInstructions = """
Controls the Excalidraw drawing app on this Mac (it is started automatically if it isn't running). \
The user sees every change live and can undo it with ⌘Z. \
Typical flow: get_scene -> add_mermaid (quickest for flowcharts) or add_elements -> \
export_image without a path to look at the result -> update_elements / delete_elements to fix it -> \
save_file or export_image with a path when the user wants a file.
"""

// JSON Schemas are kept loose on purpose: the app validates and returns readable errors.
let toolDefinitionsJSON = #"""
[
  {
    "name": "get_scene",
    "title": "Read the canvas",
    "description": "Describe what is on the Excalidraw canvas: every element's id, type, position (x, y), size, text or label, colours, arrow connections (start/end element ids), plus the overall bounds, the ids the user currently has selected, the open file and whether there are unsaved changes. Call it before editing, to find free space for new elements, and to see what the user selected. Labels of shapes and arrows are reported as `label` on the shape itself.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "include_elements": { "type": "boolean", "description": "Set false to get only the summary (counts, bounds, selection, file). Default true." }
      }
    },
    "annotations": { "readOnlyHint": true, "openWorldHint": false }
  },
  {
    "name": "add_elements",
    "title": "Draw shapes, text and arrows",
    "description": "Add elements to the canvas. Coordinates are canvas pixels (x to the right, y down); use get_scene's `bounds` to place new things next to existing ones instead of on top of them.\n\nEach element:\n- type: rectangle | ellipse | diamond | text | arrow | line | frame\n- id: optional; set one when you will connect arrows to it or edit it later. Must be unique.\n- Shapes: x, y, width, height (default 100x100; a label that doesn't fit makes the shape taller). label: {text, fontSize?} puts centred text inside.\n- text: x, y, text, fontSize (default 20). Use \\n for line breaks.\n- arrow connecting two elements: {type: \"arrow\", start: {id}, end: {id}, label?: {text}}. The ids may be elements in this same call or already on the canvas. It is routed edge to edge automatically and stays attached when the shapes move. Don't give x/y/points for these.\n- free arrow or line: x, y and points [[0,0],[dx1,dy1],...] relative to x, y.\n- frame: {type: \"frame\", children: [ids], name} groups elements visually.\n- Style (any element): strokeColor, backgroundColor (hex, e.g. stroke \"#1e1e1e\"; fills \"#a5d8ff\" blue, \"#b2f2bb\" green, \"#ffec99\" yellow, \"#ffc9c9\" red, \"#d0bfff\" violet, \"#e9ecef\" grey), fillStyle (\"solid\" | \"hachure\" | \"cross-hatch\"), strokeWidth (1 | 2 | 4), strokeStyle (\"solid\" | \"dashed\" | \"dotted\"), roughness (0 neat, 1 hand-drawn (default), 2 sketchy), opacity (0-100), roundness ({\"type\": 3} rounds corners), fontFamily (1 hand-drawn, 2 normal, 3 code), startArrowhead / endArrowhead (\"arrow\" | \"triangle\" | \"bar\" | \"dot\" | null).\n\nExample: [{\"type\":\"rectangle\",\"id\":\"api\",\"x\":0,\"y\":0,\"width\":180,\"height\":70,\"label\":{\"text\":\"API\"},\"backgroundColor\":\"#a5d8ff\",\"fillStyle\":\"solid\"},{\"type\":\"rectangle\",\"id\":\"db\",\"x\":320,\"y\":0,\"width\":180,\"height\":70,\"label\":{\"text\":\"Database\"}},{\"type\":\"arrow\",\"start\":{\"id\":\"api\"},\"end\":{\"id\":\"db\"},\"label\":{\"text\":\"SQL\"}}]\n\nReturns the created elements with their ids and final sizes.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "elements": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "object",
            "properties": {
              "type": { "type": "string", "enum": ["rectangle", "ellipse", "diamond", "text", "arrow", "line", "frame"] },
              "id": { "type": "string" },
              "x": { "type": "number" },
              "y": { "type": "number" },
              "width": { "type": "number" },
              "height": { "type": "number" },
              "text": { "type": "string" },
              "label": { "type": "object", "properties": { "text": { "type": "string" }, "fontSize": { "type": "number" } }, "required": ["text"] },
              "start": { "type": "object", "properties": { "id": { "type": "string" } } },
              "end": { "type": "object", "properties": { "id": { "type": "string" } } },
              "points": { "type": "array", "items": { "type": "array", "items": { "type": "number" } } }
            },
            "required": ["type"],
            "additionalProperties": true
          }
        },
        "zoom_to_fit": { "type": "boolean", "description": "Zoom the user's view to show everything afterwards. Default true." }
      },
      "required": ["elements"]
    },
    "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false }
  },
  {
    "name": "add_mermaid",
    "title": "Draw a Mermaid diagram",
    "description": "Turn Mermaid syntax into editable Excalidraw shapes and arrows. Usually the fastest way to draw a flowchart; the layout is done for you. Flowcharts, sequence diagrams and class diagrams become native shapes; other Mermaid diagram types are inserted as a picture. The diagram is placed to the right of what is already on the canvas. Example: \"flowchart LR\\n  A[Browser] --> B(API)\\n  B --> C[(Postgres)]\\n  B -->|cache| D{{Redis}}\"",
    "inputSchema": {
      "type": "object",
      "properties": {
        "definition": { "type": "string", "description": "Mermaid source." },
        "font_size": { "type": "number", "description": "Font size of the text in pixels. Default 16." },
        "zoom_to_fit": { "type": "boolean", "description": "Zoom the user's view to show everything afterwards. Default true." }
      },
      "required": ["definition"]
    },
    "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false }
  },
  {
    "name": "update_elements",
    "title": "Edit elements",
    "description": "Change existing elements by id. Supported fields: x, y (move), width, height, text (the text of a text element, or the label of a shape/arrow), fontSize, fontFamily, strokeColor, backgroundColor, fillStyle, strokeWidth, strokeStyle, roughness, opacity, roundness, angle (radians), points (arrows/lines), startArrowhead, endArrowhead, link, locked, groupIds, name (frames). Labels move with their shape and attached arrows are re-routed. Example: [{\"id\":\"api\",\"x\":0,\"y\":200,\"backgroundColor\":\"#b2f2bb\"},{\"id\":\"db\",\"text\":\"Postgres\"}]",
    "inputSchema": {
      "type": "object",
      "properties": {
        "updates": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "object",
            "properties": { "id": { "type": "string" } },
            "required": ["id"],
            "additionalProperties": true
          }
        }
      },
      "required": ["updates"]
    },
    "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false }
  },
  {
    "name": "delete_elements",
    "title": "Delete elements",
    "description": "Delete elements by id. A shape's label is deleted with it; arrows attached to it are kept but detached. The user can undo with ⌘Z.",
    "inputSchema": {
      "type": "object",
      "properties": { "ids": { "type": "array", "minItems": 1, "items": { "type": "string" } } },
      "required": ["ids"]
    },
    "annotations": { "readOnlyHint": false, "destructiveHint": true, "openWorldHint": false }
  },
  {
    "name": "clear_canvas",
    "title": "Clear the canvas",
    "description": "Remove everything from the canvas. The user can undo with ⌘Z. Only do this when the user asked for a fresh canvas.",
    "inputSchema": { "type": "object", "properties": {} },
    "annotations": { "readOnlyHint": false, "destructiveHint": true, "openWorldHint": false }
  },
  {
    "name": "export_image",
    "title": "Export PNG / SVG",
    "description": "Render the drawing (or only some elements) as PNG or SVG. Without `path`, a PNG is returned to you as an image: use this to look at your drawing and check the layout. With `path`, the file is written there (relative paths are relative to your working directory; folders are created).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "format": { "type": "string", "enum": ["png", "svg"], "description": "Default png." },
        "path": { "type": "string", "description": "Where to write the file, e.g. docs/architecture.png." },
        "element_ids": { "type": "array", "items": { "type": "string" }, "description": "Export only these elements (labels included). Default: everything." },
        "scale": { "type": "number", "description": "PNG pixel density. Default 2 when writing a file, 1 when returning the image." },
        "background": { "type": "boolean", "description": "Include the canvas background colour. Default true (false = transparent)." },
        "dark_mode": { "type": "boolean", "description": "Render with the dark theme. Default false." },
        "padding": { "type": "number", "description": "Margin around the drawing in pixels. Default 20." },
        "return_image": { "type": "boolean", "description": "Also return the PNG to you when writing a file. Default: only when no path is given." }
      }
    },
    "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false }
  },
  {
    "name": "save_file",
    "title": "Save .excalidraw file",
    "description": "Save the drawing as an .excalidraw file (JSON; opens in Excalidraw anywhere, including excalidraw.com). With `path`, saves there and it becomes the app's current document; without, saves to the current document's file.",
    "inputSchema": {
      "type": "object",
      "properties": { "path": { "type": "string", "description": "e.g. diagrams/flow.excalidraw (relative to your working directory). \".excalidraw\" is added if there's no extension." } }
    },
    "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false }
  },
  {
    "name": "open_file",
    "title": "Open .excalidraw file",
    "description": "Open an .excalidraw file in the app, replacing the canvas. If the canvas has unsaved changes this fails unless discard_changes is true: ask the user, or call save_file first.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "path": { "type": "string" },
        "discard_changes": { "type": "boolean", "description": "Replace the canvas even if it has unsaved changes. Default false." }
      },
      "required": ["path"]
    },
    "annotations": { "readOnlyHint": false, "destructiveHint": true, "openWorldHint": false }
  },
  {
    "name": "zoom_to_fit",
    "title": "Zoom to content",
    "description": "Scroll and zoom the user's view so all content (or the given elements) is visible.",
    "inputSchema": {
      "type": "object",
      "properties": { "element_ids": { "type": "array", "items": { "type": "string" } } }
    },
    "annotations": { "readOnlyHint": true, "openWorldHint": false }
  }
]
"""#

let toolDefinitions: JSON = {
    do {
        return try JSON.parse(toolDefinitionsJSON)
    } catch {
        fatalError("invalid tool definitions: \(error)")
    }
}()
