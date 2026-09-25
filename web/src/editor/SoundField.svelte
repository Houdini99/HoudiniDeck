<script lang="ts">
  import UiIcon from '../lib/UiIcon.svelte';
  import { uploadFile } from '../lib/upload.ts';

  // A Play Sound button's clip: upload an MP3 or WAV, and listen to it on this device.
  let { sound, name, onchange }: { sound: string; name?: string; onchange: (sound: string, name: string) => void } = $props();

  let uploading = $state(false);
  let error = $state('');
  let player = $state<HTMLAudioElement>();
  let listening = $state(false);

  async function pick(e: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    uploading = true;
    error = '';
    try {
      const uploaded = await uploadFile(file, file.name);
      if (!/\.(mp3|wav)$/.test(uploaded)) throw new Error('That is not a sound. Use an MP3 or WAV file.');
      player?.pause();
      onchange(uploaded, file.name);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      uploading = false;
    }
  }

  function listen(): void {
    if (!player) return;
    if (listening) {
      player.pause();
      player.currentTime = 0;
    } else {
      void player.play().catch(() => (listening = false));
    }
  }
</script>

<div class="sound">
  {#if sound}
    <div class="current">
      <UiIcon name="music-note" size={20} />
      <span class="name" title={name ?? sound}>{name ?? sound}</span>
      <button class="btn" type="button" onclick={listen}>
        <UiIcon name={listening ? 'stop' : 'play'} size={18} />{listening ? 'Stop' : 'Listen here'}
      </button>
    </div>
    <audio
      bind:this={player}
      src="/uploads/{sound}"
      preload="none"
      onplay={() => (listening = true)}
      onpause={() => (listening = false)}
      onended={() => (listening = false)}
    ></audio>
  {/if}
  <label class="btn file" class:disabled={uploading}>
    <UiIcon name="upload" size={18} />
    {uploading ? 'Uploading…' : sound ? 'Choose another sound…' : 'Upload a sound…'}
    <input type="file" accept="audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" disabled={uploading} onchange={pick} />
  </label>
  <small class="hint">MP3 or WAV, up to 15 MB. It plays on the PC, not on this device (“Listen here” is just a preview).</small>
  {#if error}<p class="error">{error}</p>{/if}
</div>

<style>
  .sound {
    display: grid;
    gap: 8px;
  }
  .current {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 6px 6px 10px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface-2);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file {
    position: relative;
    justify-self: start;
  }
  .file input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }
  .file.disabled {
    opacity: 0.5;
  }
</style>
