# GPU test: DeepSeek V4.1 Flash FP8 on 4x RTX PRO 6000

This is the next gate for [phase 1.5](ROADMAP.md#phase-15--your-own-gpus). One test on a rented machine with 4x RTX PRO 6000 Blackwell (PCIe, sm120) must show that this command works end to end:

```sh
dl model up deepseek-v4.1-flash-fp8 --image vllm/vllm-openai:v0.34.0rc2 --workspace /srv/dltest
```

It is written for a coding agent working from a laptop over SSH. Follow it literally, step by step. Don't change dl's code on the box, don't skip steps, and don't fix things by hand unless a step says so. When a step fails, collect what it says to collect, write it down, and go on with the next step that doesn't depend on it.

## Versions

| Part | Version needed | Why |
| --- | --- | --- |
| dl (`directionallylocal`) | **0.34.0 or later** | `--workspace`, `--allow-internet`, `dl model attach` and `dl model down` came in dl 0.33.0 (installer#245). dl 0.34.0 (installer#249) runs the agent as the workspace folder's owner with its home outside the workspace, and needs Hotcell 0.1.40. |
| Hotcell | **0.1.40 or later** | `--workspace-dir` and `--network` (hotcell#73), `--user` and `--home-dir` (hotcell#75). The dl release that pins it installs it with `dl up`. |
| Autopilot (`autopilot-ai`) | the version dl pins | Runs inside the sandbox. |
| vLLM image | `vllm/vllm-openai:v0.34.0rc2` | The catalog default, v0.33.0, lacks the sm120 fix for this model (vLLM #60762). Step I checks how it fails. |

Before renting anything, on the laptop:

```sh
npm view directionallylocal version   # must print 0.34.0 or later
```

If it prints anything older, don't rent the box. Tell the owner the gate can't run yet.

## Cost and time

- **Weights:** 475.3 GiB (510,296,708,312 bytes, 48 safetensors shards of `deepseek-ai/DeepSeek-V4.1-Flash-1017`). They download once into the Docker volume `dl-model-hf-cache`, and every later step reuses them.
- **Download time:** about 70 minutes at 1 Gbit/s, about 7 minutes at 10 Gbit/s, plus whatever Hugging Face allows. Record the real figure.
- **Images:** two vLLM images (v0.34.0rc2, and v0.33.0 in step I) and dl's sandbox image. Each vLLM image is large; record the sizes with `docker images`.
- **Model start:** dl waits up to an hour for vLLM to be ready (`VLLM_ENGINE_READY_TIMEOUT_S=3600`). Expect a long start; record it. The model starts up to four times: steps B, G, E2 and I.
- **Whole run:** budget a working day.
- **Billing:** the box bills while it exists, even when idle or powered off. When the bundle is on the laptop, destroy the instance in the provider's console (destroy, not stop: stopped instances usually keep billing for disk). Never leave the box running, not overnight and not "in case". If the run must pause, collect the bundle first, then destroy.

## Conventions

- Everything on the box runs as root, in one root shell: `sudo -i`. `dl …` in a root shell is the same as `sudo dl …` (dl's per-user files are then under `/root`).
- Results go to `R=/root/dltest-results`. Every step saves its output there under the file names given. Step 0 adds `R` to root's `.bashrc`, so new shells and tmux windows have it.
- Step E sets `SBX` to the sandbox's container name. In a new shell, set it again with `SBX=$(docker ps --format '{{.Names}}' | grep '^sbx-')`.
- Long steps run inside `tmux`, so a dropped SSH connection doesn't kill them, and inside `script`, which gives dl a terminal (it asks questions only on a terminal) and records everything it prints:

  ```sh
  tmux new -s dltest          # reattach later with: tmux attach -t dltest
  ```

  ```sh
  script -q -e -c "COMMAND" $R/FILE.typescript; echo "exit=$?"
  ```

  As an agent, drive tmux with `tmux send-keys -t dltest '…' Enter` and read it with `tmux capture-pane -p -t dltest -S -200`.
- Record the time before and after every step: `date -u +%FT%TZ | tee -a $R/times.txt` with the step letter in front, for example `echo "B start $(date -u +%FT%TZ)" >> $R/times.txt`.
- dl writes a log for every `dl model` run to `/root/.directionallylocal/logs/<timestamp>-<action>.log` (for example `…-up.log`). Note the newest one after each step: `ls -t /root/.directionallylocal/logs | head -3`.

## 0. Preconditions and box facts

Rent a machine with:

- 4x NVIDIA RTX PRO 6000 Blackwell, 96 GB each, connected over PCIe (no NVLink).
- Ubuntu 22.04 or 24.04, Nvidia driver R580 or newer (CUDA 13.0), Docker.
- At least 256 GB of RAM. The plan puts about 189 GiB of Engram tables in host RAM and limits the model's container to about 222 GiB; the sandbox adds 8 GiB.
- At least 600 GiB free on the filesystem that holds `/var/lib/docker` (the weights plus the images), 1 TB to be comfortable.

Log in, become root and record the facts:

```sh
sudo -i
echo 'export R=/root/dltest-results' >> /root/.bashrc; export R=/root/dltest-results
mkdir -p $R/facts $R/hardware $R/logs
cat /etc/os-release > $R/facts/os-release.txt; uname -a > $R/facts/uname.txt
nproc > $R/facts/nproc.txt; lscpu > $R/facts/lscpu.txt
nvidia-smi > $R/facts/nvidia-smi.txt
nvidia-smi topo -m > $R/facts/nvidia-smi-topo.txt
nvidia-smi -q > $R/facts/nvidia-smi-q-start.txt
cat /proc/driver/nvidia/version > $R/facts/driver-version.txt
free -g > $R/facts/free.txt
df -h > $R/facts/df-h.txt
docker version > $R/facts/docker-version.txt 2>&1
docker info > $R/facts/docker-info.txt 2>&1
nvidia-ctk --version > $R/facts/nvidia-ctk.txt 2>&1
docker info --format '{{json .Runtimes}}' > $R/facts/docker-runtimes.txt 2>&1
ip -4 addr show docker0 > $R/facts/docker0.txt 2>&1
```

Also save the machine in the format `dl model up --plan --hardware DIR` reads (see `src/test-support/fixtures/gpu/README.md`), so the plan can be rerun on a laptop later:

```sh
nvidia-smi --query-gpu=index,name,memory.total,memory.free,driver_version,uuid,compute_cap --format=csv,noheader,nounits > $R/hardware/nvidia-smi.csv
nvidia-smi > $R/hardware/nvidia-smi.txt
nvidia-smi topo -m > $R/hardware/topo.txt
cat /proc/meminfo > $R/hardware/meminfo
df -B1 --output=avail,target /var/lib/docker > $R/hardware/df.txt
```

**PASS:**
- `nvidia-smi.csv` has 4 lines, each naming an RTX PRO 6000 Blackwell, with `memory.total` at or above 95000 (MiB), compute capability `12.0`, and a driver of 580 or newer.
- The `nvidia-smi` header says CUDA Version 13.0 or newer.
- `nvidia-smi topo -m` shows no `NV#` between the GPUs (only PIX, PXB, PHB, NODE or SYS).
- `free -g` shows at least 250 total.
- `df.txt` shows at least 644245094400 (600 GiB) available.
- `docker version` shows a server.

**FAIL:** any of these is short. Stop here, record which fact failed, collect the bundle (see "Logs and the bundle"), and destroy the box. A smaller box can't pass the gate.

A missing Nvidia container toolkit is not a failure: `dl model up` detects it and offers to install it. Say yes, and record that it did.

Create the workspace and two markers, used by the isolation checks in step E:

```sh
mkdir -p /srv/dltest
echo "workspace marker" > /srv/dltest/HOST_MARKER.txt
echo "must not be visible in the sandbox" > /root/DLTEST_ROOT_MARKER.txt
mkdir -p /home/dltest-marker && echo "must not be visible" > /home/dltest-marker/HOME_MARKER.txt
```

## Install

```sh
curl -fsSL https://dl.new | DL_NO_START=1 sh
exec bash -l        # picks up dl on PATH
dl --version | tee $R/facts/dl-version.txt
```

**PASS:** prints 0.33.0 or later. If it prints 0.32.0, see "Versions": stop, or do the partial run only if the owner asked for it.

Then the server install, which sets up Hotcell, Autopilot's sandbox image and the services that `--workspace` needs. It doesn't need a provider key or a GitHub token for this test, so pass an empty answer set, and keep access to this machine (no Tailscale):

```sh
echo '{}' | dl up --access loopback --answers-stdin 2>&1 | tee $R/install-dl-up.txt
```

(In a root shell this is `sudo dl up`. Plain `sudo dl up` also works but asks for a provider key and a GitHub token; the test needs neither.)

Record the versions:

```sh
{
  echo "dl $(dl --version)"
  echo "hotcell $(node -p "require('/opt/directionallylocal/current/node_modules/hotcell/package.json').version")"
  echo "autopilot $(node -p "require('/opt/directionallylocal/current/node_modules/autopilot-ai/package.json').version")"
  docker images directionallylocal-cell --format '{{.Repository}}:{{.Tag}} {{.Size}}'
  systemctl is-active hotcell
} | tee $R/facts/versions.txt
dl doctor 2>&1 | tee $R/facts/dl-doctor.txt
```

**PASS:** `dl up` ends without an error; Hotcell is 0.1.40 or later; `systemctl is-active hotcell` prints `active`; an image `directionallylocal-cell:<autopilot version>` exists. `dl doctor` may flag the missing provider key and GitHub token; that is expected here. Record anything else it flags.

**FAIL:** `dl up` stops with an error, or Hotcell is older than 0.1.40. Collect `$R/install-dl-up.txt` and `journalctl -u hotcell --no-pager -n 200 > $R/logs/hotcell-install.txt`, then stop: steps E to H can't run without it.

## A. The plan

Nothing runs, downloads or is written. Run all three:

```sh
dl model up deepseek-v4.1-flash-fp8 --plan > $R/a-plan-default.txt 2>&1; echo "exit=$?"
dl model up deepseek-v4.1-flash-fp8 --plan --image vllm/vllm-openai:v0.34.0rc2 > $R/a-plan-image.txt 2>&1; echo "exit=$?"
dl model up deepseek-v4.1-flash-fp8 --plan --image vllm/vllm-openai:v0.34.0rc2 --workspace /srv/dltest > $R/a-plan-image-workspace.txt 2>&1; echo "exit=$?"
```

**PASS:**
- All three exit 0 and end their `Result` line with `fits`.
- The `--image` plans show `Engine     vLLM · vllm/vllm-openai:v0.34.0rc2 (--image; catalog default v0.33.0)` and the caveat ending "This image (vllm/vllm-openai:v0.34.0rc2) is the one the caveat names; dl hasn't verified it."
- The default plan's caveat ends "Expect to need a newer image."
- `Links` says PCIe only, no NVLink; `Layout` says tensor parallel over 4 GPUs.
- The workspace plan has a `Sandbox` section naming `/srv/dltest → /workspace`, network `dl-model-net`, and `Model API  http://model:8000/v1`.

Compare the plan's numbers with the box and write them in the report:

| Plan line | Compare with |
| --- | --- |
| `GPUs` names, total and free GiB, sm | `$R/hardware/nvidia-smi.csv` (MiB / 1024) |
| `Machine` driver and CUDA | `nvidia-smi` header |
| `Host RAM` available and the container limit | `free -g`, `MemAvailable` in `/proc/meminfo` |
| `disk` free on `/var/lib/docker` | `df -h /var/lib/docker` |
| `Memory per GPU` budget, weights, KV, buffer, left | step C's measurements |

**FAIL:** a non-zero exit, a `Result` that doesn't fit, or a number that doesn't match the box (for example the wrong GPU count or VRAM). Collect the three plan files and `$R/hardware`. If the plan says it doesn't fit, record why and stop: step B would refuse too.

## B. The real run (the gate command)

In tmux:

```sh
echo "B start $(date -u +%FT%TZ)" >> $R/times.txt
script -q -e -c "dl model up deepseek-v4.1-flash-fp8 --image vllm/vllm-openai:v0.34.0rc2 --workspace /srv/dltest --context 131072 --port 8000" $R/b-up.typescript; echo "exit=$?"
echo "B end $(date -u +%FT%TZ)" >> $R/times.txt
```

If dl offers to install the Nvidia container toolkit, accept. If it asks anything else, answer with the default and write down the question.

What should happen, in order:
1. A one-line warning that the image isn't the catalog's, and the sm120 caveat naming v0.34.0rc2.
2. The image pull, then download progress for the weights (bytes and percent moving).
3. vLLM starting: the container `dl-model-1` is up (`docker ps` in a second tmux window).
4. Four smoke tests with timings: chat, speed (decode tok/s), a tool call, and JSON.
5. The sandbox: networks created, Hotcell restarted, the cell created and checked, then lines "Open the agent  dl model attach" and "Workspace  /srv/dltest (the only host directory it sees) · reaches only the model".

**PASS:** exit 0; all four smoke tests passed; the sandbox lines printed. Write down: the download time (from the log's timestamps), the time from download end to ready, each smoke test's time, and the speed test's tok/s.

**FAIL:** a non-zero exit. Write down the exact error lines dl printed and which stage it reached (pull, download, start, which smoke test, or the sandbox). dl keeps a model container that started, for inspection. Collect, before anything else:

```sh
docker ps -a > $R/b-docker-ps.txt
docker logs dl-model-1 > $R/b-docker-logs-dl-model-1.txt 2>&1
docker inspect dl-model-1 > $R/b-inspect-dl-model-1.json 2>&1
nvidia-smi -q > $R/b-nvidia-smi-q.txt
dmesg -T | grep -i -E 'xid|nvrm|nvidia' > $R/b-dmesg-gpu.txt
cp /root/.directionallylocal/logs/*-up.log $R/logs/ 2>/dev/null
```

If the model serves but only the sandbox failed, dl says so ("The model is serving …") and names the command to retry the sandbox. Record the error, collect `journalctl -u hotcell --no-pager -n 300 > $R/b-hotcell.txt`, run that retry command once, and record the result.

## C. Memory reality

While the model serves, measure:

```sh
nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,power.draw --format=csv > $R/c-gpu-memory.csv
nvidia-smi > $R/c-nvidia-smi.txt
docker stats --no-stream > $R/c-docker-stats.txt
docker inspect --format '{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}' dl-model-1 > $R/c-memory-limit.txt
free -g > $R/c-free.txt
docker logs dl-model-1 > $R/b-docker-logs-dl-model-1.txt 2>&1
grep -i -E 'kv cache|gpu blocks|available.*memory|engram|cuda graph' $R/b-docker-logs-dl-model-1.txt > $R/c-vllm-memory-lines.txt
```

**PASS:**
- Every GPU's `memory.used` is close to the plan's per-GPU budget (87.9 GiB on 95.6 GiB cards, the plan's own figure on the real box). None is at its total.
- `docker stats` shows `dl-model-1`'s memory below its limit (about 222 GiB), and the limit in `c-memory-limit.txt` matches the plan's `--memory`.
- vLLM's log reports a KV cache size; record it in tokens.

Write a table in the report: per GPU, the plan's budget against `memory.used`; the plan's host RAM figure against `docker stats`; vLLM's reported KV cache against the plan's `left` line.

**FAIL:** a GPU near or at 100% of its memory, `docker stats` at the limit, or an out-of-memory line in `docker logs` or `dmesg`. Collect the files above plus `nvidia-smi -q > $R/c-nvidia-smi-q.txt`.

## D. Status and list

```sh
dl model status > $R/d-status.txt 2>&1; echo "exit=$?"
dl model list > $R/d-list.txt 2>&1; echo "exit=$?"
ss -ltnp | grep -E ':8000\b' > $R/d-listen-8000.txt
```

**PASS:**
- `status` names `deepseek-ai/DeepSeek-V4.1-Flash-1017`, shows `Image` as `vllm/vllm-openai:v0.34.0rc2 (--image; catalog default v0.33.0)`, GPU memory, the last smoke tests, and a `Sandbox` line with `/srv/dltest · no internet · running`.
- `list` shows one deployment on GPUs 0 to 3 (or all), port 8000, running, with the sandbox.
- Port 8000 listens on `127.0.0.1` only, never `0.0.0.0` or `*`.

If there is time, also run `dl model bench > $R/d-bench.txt 2>&1` (TTFT and tok/s at concurrency 1, 8 and 32). It's not part of the gate, but it is the first multi-GPU bench.

**FAIL:** a non-zero exit, a wrong field, or the port open beyond localhost. Collect the outputs.

## E. The sandbox and its isolation

Find the sandbox's container (Hotcell names it `sbx-<id>`; on a fresh box there is exactly one):

```sh
SBX=$(docker ps --format '{{.Names}}' | grep '^sbx-'); echo "$SBX" | tee $R/e-sandbox-name.txt
docker inspect $SBX > $R/e-inspect-sandbox.json
docker inspect dl-model-1 > $R/e-inspect-dl-model-1.json
docker network inspect dl-model-net > $R/e-network.json
grep HOTCELL_WORKSPACE_ROOTS /etc/hotcell/hotcell.env > $R/e-workspace-roots.txt
```

(Don't copy `/etc/hotcell/hotcell.env` itself: it holds Hotcell's API key.)

From the host, check the containers' settings:

```sh
docker inspect --format '{{json .Mounts}}' $SBX > $R/e-sandbox-mounts.json
docker inspect --format '{{json .HostConfig.DeviceRequests}} {{.HostConfig.Privileged}}' $SBX > $R/e-sandbox-devices.txt
docker inspect --format '{{json .NetworkSettings.Networks}}' $SBX > $R/e-sandbox-networks.json
docker inspect --format '{{json .Mounts}}' dl-model-1 > $R/e-model-mounts.json
```

Then from inside the sandbox. Save each block's output:

```sh
docker exec $SBX sh -c '
echo "== whoami"; id
echo "== /workspace"; ls -la /workspace
echo "== host markers (must be missing)"
ls /root/DLTEST_ROOT_MARKER.txt /home/dltest-marker 2>&1
echo "== /root"; ls -la /root
echo "== mounts"; cat /proc/mounts
echo "== docker socket (must be missing)"; ls -la /var/run/docker.sock /run/docker.sock 2>&1
echo "== nvidia devices (must be none)"; ls /dev/nvidia* 2>&1
echo "== default route (must be none)"; cat /proc/net/route
' > $R/e-inside.txt 2>&1

docker exec $SBX node -e "fetch('http://model:8000/v1/models',{signal:AbortSignal.timeout(5000)}).then(r=>r.text()).then(t=>{console.log('MODEL OK',t);process.exit(0)},e=>{console.log('MODEL FAIL',e.cause?.code||e.message);process.exit(1)})" > $R/e-model-reach.txt 2>&1; echo "exit=$?"

docker exec $SBX node -e "fetch('https://registry.npmjs.org/',{signal:AbortSignal.timeout(5000)}).then(r=>{console.log('INTERNET OPEN',r.status);process.exit(1)},e=>{console.log('INTERNET BLOCKED',e.cause?.code||e.message);process.exit(0)})" > $R/e-internet.txt 2>&1; echo "exit=$?"

HOSTIP=$(ip -4 -o addr show docker0 | awk '{print $4}' | cut -d/ -f1)
docker exec $SBX node -e "fetch('http://$HOSTIP:8000/v1/models',{signal:AbortSignal.timeout(5000)}).then(r=>{console.log('HOST PORT OPEN',r.status);process.exit(1)},e=>{console.log('HOST PORT BLOCKED',e.cause?.code||e.message);process.exit(0)})" > $R/e-host-port.txt 2>&1; echo "exit=$?"
```

**PASS**, all of these:
- `e-sandbox-mounts.json` has exactly one bind with `Destination` `/workspace` and `Source` `/srv/dltest`, read-write. The only other mounts are Hotcell's agent binary (`/hotcell-agent`, read-only) and Hotcell's socket (`/run/hotcell`). No volume, no `/root`, no `/home`, no `docker.sock`.
- `e-sandbox-devices.txt` shows `null false` (no GPU device requests, not privileged).
- `e-sandbox-networks.json` lists only `dl-model-net`.
- `e-model-mounts.json` has only the `dl-model-hf-cache` volume at `/root/.cache/huggingface`, and no `/srv/dltest`.
- `e-network.json` shows `"Internal": true`, and `dl-model-1` is on it (its alias `model` is in `docker inspect dl-model-1` under `NetworkSettings.Networks.dl-model-net.Aliases`).
- In `e-inside.txt`: `/workspace` lists `HOST_MARKER.txt`; both host markers are "No such file or directory"; `/root` is the image's own (no `DLTEST_ROOT_MARKER.txt`); no Docker socket; no `/dev/nvidia*`; `/proc/net/route` has no line with destination `00000000`.
- `e-model-reach.txt` says `MODEL OK` and lists the model; `e-internet.txt` says `INTERNET BLOCKED`; `e-host-port.txt` says `HOST PORT BLOCKED`.

**FAIL:** any line above that differs. Write down exactly what leaked (for example "`/root` marker visible" or "INTERNET OPEN 200"); this is the most important finding of the run. Collect `$R/e-*` and `journalctl -u hotcell --no-pager -n 300 > $R/e-hotcell.txt`.

The `--allow-internet` half of this step is E2, after step H, because a sandbox's internet setting is fixed when it's created: changing it means `dl model down` and up again.

## F. Attach and a real coding task

First check that the interactive agent opens (in tmux, since it needs a terminal):

```sh
dl model attach
```

**PASS:** Autopilot's screen opens in `/workspace` and names the model `deepseek-ai/DeepSeek-V4.1-Flash-1017` with the local `vllm` provider, without asking for a provider or a key. Ask it "What directory are you in, and what files are here?" and check it answers with `/workspace` and `HOST_MARKER.txt`. Leave with `/exit` (or Ctrl+C twice). Save the screen: `tmux capture-pane -p -t dltest -S -200 > $R/f-attach-screen.txt`.

Then one small real task, headless, so its result is a plain exit code:

```sh
echo "F start $(date -u +%FT%TZ)" >> $R/times.txt
script -q -e -c "dl model attach -- --dangerously-allow-all -p 'In /workspace, create a tiny Node.js CLI with no dependencies: package.json with name dltest-cli, version 0.1.0 and a bin entry pointing to cli.js; cli.js prints the version from package.json when run with --version and exits 0; test.js uses node:test and node:assert to run node cli.js --version and check it prints 0.1.0. Then run node --test and fix anything until it passes.'" $R/f-task.typescript; echo "exit=$?"
echo "F end $(date -u +%FT%TZ)" >> $R/times.txt
ls -ln /srv/dltest > $R/f-files.txt
(cd /srv/dltest && node cli.js --version && node --test) > $R/f-host-test.txt 2>&1; echo "exit=$?"
```

`--dangerously-allow-all` lets Autopilot write and run commands without asking. That is fine here, because the sandbox is the boundary.

**PASS:**
- The run exits 0, and `f-task.typescript` shows tool calls (files written, `node --test` run).
- `/srv/dltest` on the host now has `package.json`, `cli.js` and `test.js`. Record their owner from `f-files.txt`; the cell runs as the owner of `/srv/dltest`, so expect that uid:gid (0:0 only if root owns it).
- On the host, `node cli.js --version` prints `0.1.0` and `node --test` passes.
- Autopilot's own files are under `/var/lib/directionallylocal/workspaces/default/home/` (config, state), owned by the same uid:gid; there is no `.dl` in `/srv/dltest`, and nothing was written elsewhere on the host.

Record the task's wall time, and whether any tool call failed or was malformed (look for parser or JSON errors in `docker logs dl-model-1 2>&1 | grep -i -E 'tool|pars' | tail -50 > $R/f-vllm-tool-lines.txt`).

**FAIL:** a non-zero exit (exit 45 means the run didn't finish), no files, files elsewhere, or a failing test. Collect `$R/f-*`, `/var/lib/directionallylocal/workspaces/default/home/.config/autopilot/config.json` (copy it to `$R/f-autopilot-config.json`) and the vLLM tool lines.

## G. Update to the same model and image

Before the update, save the old container's logs (the update stops it):

```sh
docker logs dl-model-1 > $R/b-docker-logs-dl-model-1.txt 2>&1
```

First the dry run, then the real update in tmux:

```sh
dl model update deepseek-v4.1-flash-fp8 --image vllm/vllm-openai:v0.34.0rc2 --context 131072 --port 8001 --dry-run > $R/g-update-dry-run.txt 2>&1; echo "exit=$?"
echo "G start $(date -u +%FT%TZ)" >> $R/times.txt
script -q -e -c "dl model update deepseek-v4.1-flash-fp8 --image vllm/vllm-openai:v0.34.0rc2 --context 131072 --port 8001" $R/g-update.typescript; echo "exit=$?"
echo "G end $(date -u +%FT%TZ)" >> $R/times.txt
```

What should happen: the model fills every GPU, so both copies can't run side by side. dl says `Update  downtime: GPU 0 has … GB free, needs … GB per GPU` and asks `Accept downtime? y/N`. Answer `y`. It stops `dl-model-1`, starts `dl-model-2` on port 8001 with no new download (the weights are cached), runs the four smoke tests, switches, and prints `Sandbox  now on deepseek-v4.1-flash-fp8`.

Then check:

```sh
docker ps -a --format '{{.Names}} {{.Status}} {{.Ports}}' > $R/g-docker-ps.txt
dl model status > $R/g-status.txt 2>&1
docker inspect --format '{{json .NetworkSettings.Networks}}' dl-model-2 > $R/g-model2-networks.json
cat /var/lib/directionallylocal/workspaces/default/home/.config/autopilot/config.json > $R/g-autopilot-config.json
docker exec $SBX node -e "fetch('http://model:8000/v1/models',{signal:AbortSignal.timeout(5000)}).then(r=>r.text()).then(t=>{console.log('MODEL OK',t);process.exit(0)},e=>{console.log('MODEL FAIL',e.cause?.code||e.message);process.exit(1)})" > $R/g-model-reach.txt 2>&1; echo "exit=$?"
script -q -e -c "dl model attach -- --dangerously-allow-all -p 'Run node --test in /workspace and tell me the result.'" $R/g-attach.typescript; echo "exit=$?"
```

**PASS:**
- The update exits 0, and it said it kept the `--image` (or used the one given) rather than switching to v0.33.0.
- `dl-model-2` is up on `127.0.0.1:8001`; `dl-model-1` is stopped or gone (record which).
- `status` shows `dl-model-2`, port 8001 and the same image.
- `dl-model-2` is on `dl-model-net` with the alias `model`, and the sandbox still reaches `http://model:8000/v1` (`MODEL OK`). The URL doesn't change, because 8000 is the container's port.
- Autopilot's config still names `http://model:8000/v1` and the model.
- The short attach run exits 0.
- Record the downtime: from the old container stopping to the new one passing its smoke tests.

**FAIL:** a non-zero exit, or the sandbox not following. If the new model failed, dl should have brought back the old one: record whether `dl-model-1` serves again and whether `status` shows it. Collect `docker logs dl-model-2 > $R/g-docker-logs-dl-model-2.txt 2>&1`, `docker inspect dl-model-2 > $R/g-inspect-dl-model-2.json` and the newest `…-update.log`.

## H. Down

Save everything the containers hold first (down removes them):

```sh
docker logs dl-model-2 > $R/g-docker-logs-dl-model-2.txt 2>&1
docker inspect dl-model-2 > $R/g-inspect-dl-model-2.json 2>&1
docker inspect $SBX > $R/h-inspect-sandbox-before-down.json 2>&1
```

Then:

```sh
script -q -e -c "dl model down" $R/h-down.typescript; echo "exit=$?"
docker ps -a --format '{{.Names}} {{.Status}}' > $R/h-docker-ps.txt
docker network ls > $R/h-networks.txt
docker volume ls > $R/h-volumes.txt
grep HOTCELL_WORKSPACE_ROOTS /etc/hotcell/hotcell.env > $R/h-workspace-roots.txt
dl model list > $R/h-list.txt 2>&1
ls -la /srv/dltest > $R/h-workspace-after.txt
```

**PASS:**
- `down` exits 0 and says it stopped the model and its sandbox, and that `/srv/dltest` is untouched.
- `h-docker-ps.txt` has no `dl-model-*` and no `sbx-*` container.
- `h-networks.txt` has no `dl-model-net` or `dl-model-net-egress`.
- `HOTCELL_WORKSPACE_ROOTS` no longer contains `/srv/dltest`; `systemctl is-active hotcell` prints `active`.
- `dl model list` shows no deployment.
- `/srv/dltest` still has `HOST_MARKER.txt` and the CLI files; `/var/lib/directionallylocal/workspaces/default/home` is gone.
- Record whether the volume `dl-model-hf-cache` is still there (expected: kept, so the weights aren't downloaded again).

**FAIL:** anything left behind, or anything in `/srv/dltest` removed. Collect `$R/h-*`.

## E2. The sandbox with --allow-internet

This starts the model again from the cached weights, with a sandbox that may reach the internet:

```sh
echo "E2 start $(date -u +%FT%TZ)" >> $R/times.txt
script -q -e -c "dl model up deepseek-v4.1-flash-fp8 --image vllm/vllm-openai:v0.34.0rc2 --workspace /srv/dltest --allow-internet --context 131072 --port 8000" $R/e2-up.typescript; echo "exit=$?"
echo "E2 end $(date -u +%FT%TZ)" >> $R/times.txt
SBX=$(docker ps --format '{{.Names}}' | grep '^sbx-'); echo "$SBX" > $R/e2-sandbox-name.txt
docker inspect --format '{{json .NetworkSettings.Networks}}' $SBX > $R/e2-sandbox-networks.json
docker exec $SBX node -e "fetch('https://registry.npmjs.org/',{signal:AbortSignal.timeout(5000)}).then(r=>{console.log('INTERNET OPEN',r.status);process.exit(0)},e=>{console.log('INTERNET BLOCKED',e.cause?.code||e.message);process.exit(1)})" > $R/e2-internet.txt 2>&1; echo "exit=$?"
docker exec $SBX node -e "fetch('http://model:8000/v1/models',{signal:AbortSignal.timeout(5000)}).then(r=>r.text()).then(t=>{console.log('MODEL OK',t);process.exit(0)},e=>{console.log('MODEL FAIL',e.cause?.code||e.message);process.exit(1)})" > $R/e2-model-reach.txt 2>&1; echo "exit=$?"
dl model status > $R/e2-status.txt 2>&1
```

**PASS:** `up` exits 0 with no new download; the sandbox is on `dl-model-net` and `dl-model-net-egress`; `INTERNET OPEN 200`; `MODEL OK`; `status` shows `internet allowed`. Record the start time from cached weights.

**FAIL:** collect `$R/e2-*`, `docker logs dl-model-1 > $R/e2-docker-logs-dl-model-1.txt 2>&1` and `journalctl -u hotcell --no-pager -n 300 > $R/e2-hotcell.txt`.

Then remove it again, and check as in step H:

```sh
docker logs dl-model-1 > $R/e2-docker-logs-dl-model-1.txt 2>&1
script -q -e -c "dl model down" $R/e2-down.typescript; echo "exit=$?"
docker ps -a --format '{{.Names}} {{.Status}}' > $R/e2-docker-ps-after-down.txt
docker network ls > $R/e2-networks-after-down.txt
```

## I. The catalog's default image (expected to fail)

The catalog still pins `vllm/vllm-openai:v0.33.0`, and the plan's caveat says it will likely fail on sm120 (vLLM issue #59203: the mxfp4 indexer rejected on SM120 on the release tag; the fix, #60762, is only in v0.34.0rc2). Record exactly how it fails:

```sh
echo "I start $(date -u +%FT%TZ)" >> $R/times.txt
script -q -e -c "dl model up deepseek-v4.1-flash-fp8 --context 131072 --port 8000" $R/i-up.typescript; echo "exit=$?"
echo "I end $(date -u +%FT%TZ)" >> $R/times.txt
docker ps -a > $R/i-docker-ps.txt
docker logs dl-model-1 > $R/i-docker-logs-dl-model-1.txt 2>&1
docker inspect dl-model-1 > $R/i-inspect-dl-model-1.json 2>&1
grep -n -i -E 'error|exception|traceback|not supported|unsupported|sm_?120|mxfp4|indexer' $R/i-docker-logs-dl-model-1.txt | head -80 > $R/i-error-lines.txt
nvidia-smi -q > $R/i-nvidia-smi-q.txt
dmesg -T | grep -i -E 'xid|nvrm|nvidia' > $R/i-dmesg-gpu.txt
```

If vLLM neither fails nor gets ready within 30 minutes after the weights finish loading, stop waiting: press Ctrl+C, record "hung" and the last 100 lines of `docker logs dl-model-1`.

**Expected:** a non-zero exit, with dl reporting that the model didn't start or failed a smoke test. Record:
- The stage it failed at (pull, start, readiness, which smoke test).
- dl's exact error lines.
- vLLM's first error and its traceback's last lines (`i-error-lines.txt`).
- Whether it names sm120, the mxfp4 indexer or the attention backend.

If it **passes**, that matters just as much: record the four smoke tests and tok/s as in step B.

Then clean up:

```sh
docker rm -f dl-model-1
dl model list > $R/i-list-after.txt 2>&1
```

If `dl model list` still shows a deployment, run `dl model down` and record that it was needed.

## Logs and the bundle

Collect these at the end (and at any failure you can't recover from):

```sh
mkdir -p $R/logs/root $R/logs/users
cp /root/.directionallylocal/logs/*.log $R/logs/root/ 2>/dev/null
for d in /home/*/.directionallylocal/logs; do [ -d "$d" ] && cp "$d"/*.log $R/logs/users/ 2>/dev/null; done
cp /root/.local/state/directionallylocal/model.json $R/logs/model-state.json 2>/dev/null
journalctl -u hotcell --no-pager > $R/logs/hotcell-journal.txt
journalctl -u docker --no-pager --since today > $R/logs/docker-journal.txt
dmesg -T | tail -300 > $R/logs/dmesg-tail.txt
dmesg -T | grep -i -E 'xid|nvrm|nvidia' > $R/logs/dmesg-gpu.txt
nvidia-smi -q > $R/logs/nvidia-smi-q-end.txt
docker ps -a > $R/logs/docker-ps-end.txt
docker images > $R/logs/docker-images.txt
docker system df > $R/logs/docker-system-df.txt
cp -r /var/lib/directionallylocal/workspaces/default/home $R/logs/agent-home 2>/dev/null
```

The container logs (`docker logs dl-model-1`, `dl-model-2`) and `docker inspect` outputs for the model and sandbox containers are saved by the steps above, before `down` removes the containers. Check that `$R/b-docker-logs-dl-model-1.txt`, `$R/g-docker-logs-dl-model-2.txt`, `$R/e-inspect-sandbox.json` and `$R/i-docker-logs-dl-model-1.txt` exist.

Nothing in the bundle should be secret: the model is public, the sandbox has no keys, and the install was given no provider key or GitHub token. Check anyway; this must print nothing:

```sh
grep -rIl -E 'hf_[A-Za-z0-9]{30,}|HF_TOKEN=[^ ]+|HOTCELL_API_KEY|ghp_[A-Za-z0-9]{30,}|github_pat_|sk-[A-Za-z0-9]{20,}' $R
```

If it prints a file, look at the match. If it's a real token, remove that line from the file (and note it in the report), then check again.

Bundle and copy to the laptop:

```sh
TAR=/root/dltest-4x6000-$(date -u +%Y%m%dT%H%MZ).tar.gz
tar -czf $TAR -C /root dltest-results && ls -lh $TAR
```

On the laptop:

```sh
scp root@BOX:/root/dltest-4x6000-*.tar.gz .
tar -tzf dltest-4x6000-*.tar.gz | head
```

Then destroy the box (see "Cost and time").

## Report template

Copy this, fill it in, and attach the bundle.

```markdown
# 4x RTX PRO 6000 gate: DeepSeek V4.1 Flash FP8, <date>

**Result:** PASS / FAIL (gate command: dl model up deepseek-v4.1-flash-fp8 --image vllm/vllm-openai:v0.34.0rc2 --workspace /srv/dltest)

## Box
- Provider and region: <…> · OS: <…> · kernel: <…>
- GPUs: 4x <exact name> · <MiB each> · sm <…> · links: <from topo -m>
- Driver <…> · CUDA <…> · RAM <total GiB> · free on /var/lib/docker <GiB> · Docker <…> · nvidia-ctk <…>
- dl <…> · Hotcell <…> · Autopilot <…>

## Steps
| Step | Result | Numbers | Notes |
| --- | --- | --- | --- |
| 0 Preconditions | PASS/FAIL | | |
| Install | PASS/FAIL | | |
| A Plan | PASS/FAIL | | plan vs box: <differences> |
| B Up (gate command) | PASS/FAIL | download <min>, start <min>, chat <s>, speed <tok/s>, tool <s>, JSON <s> | |
| C Memory | PASS/FAIL | per GPU used <GiB> vs plan 87.9; container RAM <GiB> vs limit <GiB>; KV <tokens> | |
| D Status and list | PASS/FAIL | bench: <if run> | |
| E Isolation | PASS/FAIL | | what leaked, if anything |
| F Attach and task | PASS/FAIL | task <min> | file owner <uid>; tool calls ok? |
| G Update | PASS/FAIL | downtime <min> | sandbox followed? |
| H Down | PASS/FAIL | | left behind? cache kept? |
| E2 --allow-internet | PASS/FAIL | start from cache <min> | |
| I v0.33.0 default | FAILED AS EXPECTED / PASSED / HUNG | | stage and first error |

## Issues
For each: the step, what happened, the exact error, a log excerpt (file name and lines), and what you think the cause is (marked as a guess).

## Times
<paste $R/times.txt>

## Bundle
<file name and size>; secret check printed nothing: yes/no
```
