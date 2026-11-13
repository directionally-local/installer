# GPU machine fixtures

What `dl model up --plan --hardware DIR` reads instead of probing this machine, and what the
multi-GPU tests plan against. Each directory holds a machine's command output, in the formats
the real commands print:

- `nvidia-smi.csv`: `nvidia-smi --query-gpu=index,name,memory.total,memory.free,driver_version,uuid,compute_cap --format=csv,noheader,nounits`
- `nvidia-smi.txt`: the head of plain `nvidia-smi` (dl reads the CUDA version from it)
- `topo.txt`: `nvidia-smi topo -m` (absent for a single GPU: dl doesn't run it then)
- `meminfo`: `/proc/meminfo` (MemTotal and MemAvailable)
- `df.txt`: `df -B1 --output=avail,target /var/lib/docker` (where Docker keeps the model cache volume)

The machines are representative, not captures from a specific box: UUIDs are made up, and
memory figures are what these GPU models report.

| Directory | GPUs | Interconnect | RAM |
|---|---|---|---|
| `rtx-pro-5000-1x` | 1x RTX PRO 5000 Blackwell, 48 GB | none | 64 GB |
| `rtx-pro-6000-4x-pcie` | 4x RTX PRO 6000 Blackwell Max-Q, 96 GB, 300 W | PCIe only (NODE), no NVLink | 256 GB |
| `h100-8x-nvlink` | 8x H100 SXM 80 GB | NVLink (NV18) | 2 TB |
