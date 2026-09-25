<script lang="ts">
  import type { IconRef } from '$shared/schema.ts';

  // Fills its container. Set icons are masks so they take the button's text color.
  let { icon, cover = false }: { icon: IconRef; cover?: boolean } = $props();
</script>

{#if 'set' in icon}
  <span class="icon mask" style:--src="url(/icons/{icon.set}/{icon.name}.svg)" aria-hidden="true"></span>
{:else if 'upload' in icon}
  <img class="icon" class:cover src="/uploads/{icon.upload}" alt="" draggable="false" />
{:else}
  <span class="icon emoji" aria-hidden="true">{icon.emoji}</span>
{/if}

<style>
  .icon {
    display: block;
    width: 100%;
    height: 100%;
  }
  .mask {
    background-color: currentColor;
    -webkit-mask: var(--src) center / contain no-repeat;
    mask: var(--src) center / contain no-repeat;
  }
  img {
    object-fit: contain;
    pointer-events: none;
    -webkit-user-drag: none;
  }
  img.cover {
    object-fit: cover;
  }
  .emoji {
    display: grid;
    place-items: center;
    font-size: calc(var(--icon-size, 24px) * 0.82);
    line-height: 1;
  }
</style>
