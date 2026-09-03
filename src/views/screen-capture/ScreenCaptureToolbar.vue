<template>
  <div class="capture-toolbar" role="toolbar" aria-label="Screen capture tools" @pointerdown.stop @dblclick.stop @contextmenu.stop.prevent>
    <div class="capture-toolbar__group" aria-label="Annotation tools">
      <button
        v-for="tool in tools"
        :key="tool.id"
        type="button"
        class="capture-toolbar__button"
        :class="{ active: activeTool === tool.id }"
        :data-tool="tool.id"
        :aria-label="tool.label"
        :title="tool.label"
        :aria-pressed="activeTool === tool.id"
        :disabled="busy"
        @click="$emit('tool', tool.id)"
      >
        <span aria-hidden="true">{{ tool.icon }}</span>
      </button>
    </div>

    <span class="capture-toolbar__divider" aria-hidden="true" />

    <div class="capture-toolbar__group" aria-label="History">
      <button type="button" class="capture-toolbar__button" aria-label="Undo" title="Undo" :disabled="busy || !canUndo" @click="$emit('undo')">↶</button>
      <button type="button" class="capture-toolbar__button" aria-label="Redo" title="Redo" :disabled="busy || !canRedo" @click="$emit('redo')">↷</button>
    </div>

    <div class="capture-toolbar__group capture-toolbar__colors" aria-label="Colors">
      <button
        v-for="preset in colors"
        :key="preset"
        type="button"
        class="capture-toolbar__color"
        :class="{ active: color === preset }"
        :style="{ '--capture-color': preset }"
        :data-color="preset"
        :aria-label="`Color ${preset}`"
        :title="`Color ${preset}`"
        :aria-pressed="color === preset"
        :disabled="busy"
        @click="$emit('color', preset)"
      />
    </div>

    <div class="capture-toolbar__group" aria-label="Stroke width">
      <button
        v-for="width in strokeWidths"
        :key="width"
        type="button"
        class="capture-toolbar__stroke"
        :class="{ active: strokeWidth === width }"
        :data-stroke-width="width"
        :aria-label="`Stroke width ${width}`"
        :title="`Stroke width ${width}`"
        :aria-pressed="strokeWidth === width"
        :disabled="busy"
        @click="$emit('stroke-width', width)"
      >
        <span :style="{ height: `${Math.max(2, width / 2)}px` }" aria-hidden="true" />
      </button>
    </div>

    <span class="capture-toolbar__divider" aria-hidden="true" />

    <div class="capture-toolbar__group" aria-label="Capture actions">
      <button type="button" class="capture-toolbar__button" data-action="save" aria-label="Save" title="Save" :disabled="busy" @click="$emit('action', 'save')">⇩</button>
      <button type="button" class="capture-toolbar__button" data-action="copy" aria-label="Copy" title="Copy" :disabled="busy" @click="$emit('action', 'copy')">⧉</button>
      <button type="button" class="capture-toolbar__button" data-action="cancel" aria-label="Cancel" title="Cancel" :disabled="busy" @click="$emit('cancel')">×</button>
      <button
        type="button"
        class="capture-toolbar__button capture-toolbar__confirm"
        data-action="confirm"
        aria-label="Confirm"
        :title="canConfirm ? 'Confirm' : 'Open a chat to send'"
        :disabled="busy || !canConfirm"
        @click="$emit('action', 'confirm')"
      >
        ✓
      </button>
    </div>
  </div>
</template>

<script lang="ts">
export type CaptureAnnotationTool = 'rect' | 'ellipse' | 'arrow' | 'brush' | 'text' | 'mosaic'
export type CaptureExportAction = 'save' | 'copy' | 'confirm'
</script>

<script setup lang="ts">
interface Props {
  activeTool: CaptureAnnotationTool | null
  color: string
  strokeWidth: number
  canUndo: boolean
  canRedo: boolean
  busy: boolean
  canConfirm: boolean
}

defineProps<Props>()

defineEmits<{
  tool: [tool: CaptureAnnotationTool]
  color: [color: string]
  'stroke-width': [width: number]
  undo: []
  redo: []
  action: [action: CaptureExportAction]
  cancel: []
}>()

const tools: ReadonlyArray<{ id: CaptureAnnotationTool; label: string; icon: string }> = [
  { id: 'rect', label: 'Rectangle', icon: '□' },
  { id: 'ellipse', label: 'Ellipse', icon: '○' },
  { id: 'arrow', label: 'Arrow', icon: '↗' },
  { id: 'brush', label: 'Pen', icon: '⌁' },
  { id: 'text', label: 'Text', icon: 'T' },
  { id: 'mosaic', label: 'Mosaic', icon: '▦' },
]

const colors = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6'] as const
const strokeWidths = [2, 4, 8] as const
</script>

<style scoped>
.capture-toolbar {
  display: flex;
  align-items: center;
  gap: 5px;
  min-height: 44px;
  padding: 6px;
  color: #f8fafc;
  background: rgb(24 24 27 / 96%);
  border: 1px solid rgb(255 255 255 / 16%);
  border-radius: 9px;
  box-shadow: 0 8px 30px rgb(0 0 0 / 42%);
  user-select: none;
}

.capture-toolbar__group {
  display: flex;
  align-items: center;
  gap: 3px;
}

.capture-toolbar__button,
.capture-toolbar__stroke,
.capture-toolbar__color {
  display: grid;
  place-items: center;
  box-sizing: border-box;
  color: inherit;
  background: transparent;
  border: 0;
  border-radius: 5px;
  cursor: pointer;
}

.capture-toolbar__button,
.capture-toolbar__stroke {
  width: 32px;
  height: 32px;
  font:
    600 17px/1 system-ui,
    sans-serif;
}

.capture-toolbar__button:hover:not(:disabled),
.capture-toolbar__button.active,
.capture-toolbar__stroke:hover:not(:disabled),
.capture-toolbar__stroke.active {
  background: rgb(255 255 255 / 14%);
}

.capture-toolbar__button:focus-visible,
.capture-toolbar__stroke:focus-visible,
.capture-toolbar__color:focus-visible {
  outline: 2px solid #60a5fa;
  outline-offset: 1px;
}

.capture-toolbar__button:disabled,
.capture-toolbar__stroke:disabled,
.capture-toolbar__color:disabled {
  cursor: default;
  opacity: 0.38;
}

.capture-toolbar__divider {
  width: 1px;
  height: 24px;
  margin: 0 2px;
  background: rgb(255 255 255 / 18%);
}

.capture-toolbar__colors {
  padding: 0 2px;
}

.capture-toolbar__color {
  width: 20px;
  height: 20px;
  margin: 0 1px;
  background: var(--capture-color);
  border: 2px solid transparent;
  border-radius: 50%;
}

.capture-toolbar__color.active {
  border-color: #fff;
  box-shadow: 0 0 0 1px #111827;
}

.capture-toolbar__stroke span {
  display: block;
  width: 19px;
  max-height: 8px;
  background: currentcolor;
  border-radius: 999px;
}

.capture-toolbar__confirm {
  color: #052e16;
  background: #4ade80;
}

.capture-toolbar__confirm:hover:not(:disabled) {
  background: #86efac;
}
</style>
