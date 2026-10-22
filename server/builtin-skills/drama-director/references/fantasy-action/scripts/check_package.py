#!/usr/bin/env python3
import os
import sys

def check_package():
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    skill_file = os.path.join(base_dir, "SKILL.md")
    readme_file = os.path.join(base_dir, "README.md")
    refs_dir = os.path.join(base_dir, "references")
    
    expected_refs = [
        "01-core-combat-laws-and-protocols.md",
        "02-camera-specs-and-15modes.md",
        "03-close-quarters-combat-engine.md",
        "04-xuanhuan-elements-and-vfx.md",
        "05-grand-scale-domains-and-formations.md",
        "06-martial-and-magic-arsenal.md",
        "07-arsenal-parameter-library.md",
        "08-character-and-scene-presets.md"
    ]
    
    print("Checking xuanhuan-combat-director Skill Package (V2.5.0 Complete)...")
    if not os.path.exists(skill_file):
        print("[-] SKILL.md is missing!")
        sys.exit(1)
    print("[+] SKILL.md found.")
    
    if not os.path.exists(readme_file):
        print("[-] README.md is missing!")
        sys.exit(1)
    print("[+] README.md found.")
    
    missing = []
    for r in expected_refs:
        path = os.path.join(refs_dir, r)
        if not os.path.exists(path):
            missing.append(r)
        else:
            print(f"[+] Reference found: {r}")
            
    if missing:
        print(f"[-] Missing references: {missing}")
        sys.exit(1)
        
    print("[+] All 8 references verified. Package is complete, self-contained, and ready for any platform!")

if __name__ == "__main__":
    check_package()
