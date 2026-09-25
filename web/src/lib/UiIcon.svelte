<script lang="ts">
  // Material Design icon for app chrome, tinted with the current text color.
  let { name, size = 20 }: { name: string; size?: number } = $props();
</script>

<span class="ui-icon" style:--src="url(/icons/mdi/{name}.svg)" style:width="{size}px" style:height="{size}px" aria-hidden="true"></span>

<style>
  .ui-icon {
    display: inline-block;
    flex: none;
    background-color: currentColor;
    -webkit-mask: var(--src) center / contain no-repeat;
    mask: var(--src) center / contain no-repeat;
  }
</style>
