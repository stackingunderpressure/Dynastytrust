"""
generate.py -- writes protocol/tests/vectors/ranged.json, the expected
addresses for ranged (v2) vaults, from two implementations that are NOT the
crate under test:

  * Bitcoin Core: getdescriptorinfo (checksums) and deriveaddresses on the
    /0/* and /1/* descriptors, receive and change 0-9;
  * embit (the library SeedSigner uses) on the <0;1>/* multipath descriptor.

It also checks what the Rust crate derived (from the ranged_vectors example)
and refuses to write anything unless all three agree. The Rust test then
compares the crate against the stored Core answers.

  cargo run -q -p dynastytrust_protocol --example ranged_vectors > shapes.json
  BITCOIND=/path/to/bitcoind python3 -I scripts/ranged-vectors/generate.py shapes.json

Needs bitcoind (any version that knows tr() miniscript; made with 32.1) and
embit on the Python path. Starts its own throwaway regtest node.
"""
import json
import os
import subprocess
import sys
import tempfile
import time

from embit.descriptor import Descriptor
from embit.networks import NETWORKS

shapes_path = sys.argv[1]
bitcoind = os.environ["BITCOIND"]
cli = os.path.join(os.path.dirname(bitcoind), "bitcoin-cli")
datadir = tempfile.mkdtemp(prefix="ranged-vectors-")
base = [cli, "-regtest", "-datadir=" + datadir, "-rpcport=18999"]


def rpc(*args):
    out = subprocess.run(base + list(args), capture_output=True, text=True, check=True).stdout
    return json.loads(out)


subprocess.run([bitcoind, "-regtest", "-datadir=" + datadir, "-rpcport=18999", "-listen=0", "-daemon", "-disablewallet"], check=True)
try:
    for _ in range(60):
        try:
            rpc("getblockchaininfo")
            break
        except subprocess.CalledProcessError:
            time.sleep(0.5)
    core_version = rpc("getnetworkinfo")["subversion"]

    shapes = json.load(open(shapes_path))["shapes"]
    out = []
    for s in shapes:
        entry = dict(s)
        entry.pop("rust_receive")
        entry.pop("rust_change")
        for key, branch in (("receive", 0), ("change", 1)):
            d = s[key + "_descriptor"]
            info = rpc("getdescriptorinfo", d)
            # Core's checksum must equal the one the crate wrote.
            assert d.endswith("#" + info["checksum"]), (s["name"], key, d[-10:], info["checksum"])
            core = rpc("deriveaddresses", d, "[0,9]")
            emb_desc = Descriptor.from_string(s["multipath_descriptor"].split("#")[0])
            emb = [emb_desc.derive(i, branch_index=branch).address(NETWORKS["regtest"]) for i in range(10)]
            rust = s["rust_" + key]
            assert core == emb, (s["name"], key, "Core and embit disagree", core, emb)
            assert core == rust, (s["name"], key, "Core and the crate disagree", core, rust)
            entry[key] = core
        out.append(entry)

    dest = os.path.join(os.path.dirname(__file__), "..", "..", "protocol", "tests", "vectors", "ranged.json")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w") as f:
        json.dump({
            "about": "Expected ranged (v2) vault addresses, receive and change 0-9. Made by scripts/ranged-vectors/generate.py from Bitcoin Core deriveaddresses, confirmed by embit and by the crate; do not edit by hand.",
            "generated_with": core_version,
            "shapes": out,
        }, f, indent=1)
        f.write("\n")
    print("wrote", len(out), "shapes; Core, embit and the crate agree on", 20 * len(out), "addresses")
finally:
    subprocess.run(base + ["stop"], capture_output=True)
