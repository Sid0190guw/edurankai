"""
Seed corpus for the AES teacher-intent classifier (spec section 12).

WHY SYNTHETIC. There are no recorded teaching sessions yet, and the production database is off
limits for training data by house rule and by good sense — it holds real people. So the corpus is
authored here: templates over slot values, expanded combinatorially. That is honest bootstrapping,
not a substitute for real data. The moment real teacher utterances exist they replace these, and the
templates remain only to cover classes the real data is thin on.

WHAT IT MUST GET RIGHT. The hard part of this task is not telling "show the atom" from "why does
this happen". It is telling ORDINARY SPEECH from a REQUEST. A teacher says "now we will look at
harmonic motion" as narration, and "let us look at the oscillation" as an instruction, and the
difference is not in the vocabulary. So NORMAL_SPEECH is deliberately over-represented with
sentences that contain every trigger word the other classes use. A classifier that has only seen
clean commands will fire on half of a lecture.

Run:  python ml/intent/dataset.py
Writes ml/intent/data/{train,dev,test}.jsonl with a stratified, group-disjoint split.
"""

import json
import os
import random
from itertools import product

SEED = 20260810  # fixed: the split must be reproducible, or an eval score means nothing
random.seed(SEED)

OUT = os.path.join(os.path.dirname(__file__), "data")

# The ten classes of spec section 12, in the spec's own order.
LABELS = [
    "normal_speech",
    "visualization_request",
    "object_generation",
    "animation_request",
    "parameter_modification",
    "camera_command",
    "annotation",
    "simulation_command",
    "comparison",
    "explanation",
]

# Slot vocabularies. Kept small and physical, because the first courses are science courses.
OBJECT = [
    "atom", "electron", "proton", "molecule", "pendulum", "spring", "block", "wave",
    "particle", "magnet", "current-carrying wire", "capacitor", "lens", "prism",
    "projectile", "satellite", "gas cylinder", "circuit", "beam", "crystal lattice",
]
QUANTITY = [
    "amplitude", "frequency", "wavelength", "phase", "velocity", "acceleration",
    "displacement", "restoring force", "kinetic energy", "potential energy",
    "total energy", "momentum", "charge", "field strength", "period", "mass",
]
CONCEPT = [
    "harmonic motion", "simple harmonic motion", "damped oscillation", "resonance",
    "projectile motion", "circular motion", "wave interference", "diffraction",
    "refraction", "electromagnetic induction", "the photoelectric effect",
    "conservation of momentum", "Newton's second law", "the ideal gas law",
]
DIRECTION = ["increase", "decrease", "double", "halve", "raise", "reduce", "lower", "bump up"]
SPEED = ["slow it down", "speed it up", "run it slower", "run it faster", "pause it", "play it again"]

# ---------------------------------------------------------------------------------------------
# Templates per class. Each is a format string over the slots above.
# ---------------------------------------------------------------------------------------------

TEMPLATES = {
    # Narration, housekeeping and teaching talk. The trap class, on purpose: these contain the same
    # verbs and nouns as the command classes. If the model cannot hold this boundary it will
    # interrupt a lecture with a visualization every third sentence.
    "normal_speech": [
        "now we will discuss {concept}",
        "today we are going to study {concept}",
        "in the last class we covered {concept}",
        "so this brings us to {concept}",
        "as you can see in your textbook the {object} has a fixed {quantity}",
        "many students find {concept} difficult at first",
        "this was asked in last year's examination",
        "please open your notebooks",
        "we will come back to the {object} after the break",
        "I want you to remember the {quantity} of the {object}",
        "there is an important point here about {concept}",
        "let me first write the equation on the board",
        "the {quantity} is what we measure in the laboratory",
        "any questions before we move on",
        "this chapter is important for your assessment",
        "we do not have time for {concept} today",
        "I will show you {concept} in the next class",
        "the {object} is a good example of {concept}",
        "you should read about {concept} before Friday",
        "keep the {quantity} in mind, it will matter later",
        "so that is the definition of {quantity}",
        "hold on, let me check my notes",
        "can everyone at the back hear me",
        "we already saw how the {object} behaves",
        "this is a standard result and you can quote it",
        # The boundary is decided here. The first run misread half of all narration as an
        # instruction because it had seen only 25 shapes of teacher-talk and hundreds of command
        # shapes. These are deliberately built from the SAME verbs and nouns the command classes
        # use — see, show, look, run, compare, why — because that is precisely where the model was
        # failing. Narration that shares no vocabulary with commands teaches nothing.
        "we can see from the equation that the {quantity} is constant",
        "if you look at the diagram in the book the {object} is at rest",
        "you will see this again when we do {concept}",
        "let us say the {quantity} is ten units",
        "suppose the {object} starts from rest",
        "consider a {object} at equilibrium",
        "imagine the {object} is displaced slightly",
        "think about what the {quantity} would be",
        "the experiment shows that the {quantity} doubles",
        "in the simulation we did last week the {object} moved slowly",
        "compare that with what you already know about {concept}",
        "the difference between the two is not important right now",
        "why this happens is a question for the next chapter",
        "the reason is given in the derivation",
        "we will run through the derivation on the board",
        "run your eye down the column of results",
        "show of hands, who has read the chapter",
        "I will show the answer at the end",
        "look at the time, we are running late",
        "increase in the {quantity} means the {object} moves faster, as you know",
        "a smaller {quantity} gives a longer period, remember that",
        "zoom is not the issue here, the concept is",
        "highlight this line in your notes",
        "label your axes properly in the examination",
        "animate is just a word, the physics is what matters",
        "the {object} in the picture is not to scale",
        "this is what we call {concept}",
        "that is all for today",
        "we are out of time",
        "read the summary at the end of the chapter",
        "your assignment is due on Monday",
        "there will be a quiz next week on {concept}",
        "the formula for {quantity} should be memorised",
        "this derivation is not in your syllabus",
        "do not worry about the mathematics for now",
        "the {quantity} and the {quantity} are related",
        "most textbooks write it the other way round",
        "my apologies, that was a mistake on the board",
        "let me rephrase that",
        "as I was saying about {concept}",
        "where were we",
        "good question, we will come to it",
        "exactly, that is the point",
        "not quite, try again",
        "has everyone written this down",
        "turn to page forty",
        "the {object} example is the classic one",
        "in industry this matters for design",
        "historically {concept} was discovered by accident",
        "this connects to what you learned in chemistry",
    ],
    "visualization_request": [
        "let us see how the {object} behaves",
        "let's visualise {concept}",
        "I want to show you {concept}",
        "let us look at what happens to the {object}",
        "can we see {concept} on the screen",
        "put {concept} up for them",
        "let us picture the {object} for a moment",
        "show them what {concept} looks like",
        "bring up a visualization of {concept}",
        "let's see this on the display",
        "I'd like a diagram of {concept}",
        "give me a picture of the {object}",
    ],
    "object_generation": [
        "show the {object}",
        "put an {object} on the screen",
        "add a {object}",
        "create a {object}",
        "give me a {object}",
        "draw a {object}",
        "place a {object} in the centre",
        "I need a {object} here",
        "add another {object} beside it",
        "show two {object}s",
    ],
    "animation_request": [
        "make it oscillate",
        "make the {object} move",
        "animate the {object}",
        "let it oscillate now",
        "start the motion",
        "make it swing",
        "set it in motion",
        "let the {object} fall",
        "make the {object} rotate",
        "show it moving",
    ],
    "parameter_modification": [
        "{direction} the {quantity}",
        "{direction} the {quantity} of the {object}",
        "{speed}",
        "make the {quantity} larger",
        "make the {quantity} smaller",
        "set the {quantity} to twice its value",
        "change the {quantity}",
        "give it more {quantity}",
        "reduce the {quantity} a little",
        "{direction} it by half",
    ],
    "camera_command": [
        "zoom into the {object}",
        "zoom out a bit",
        "rotate the view",
        "turn it around",
        "look at it from the side",
        "show me the top view",
        "move the camera closer",
        "let us see it from behind",
        "pan to the left",
        "get closer to the {object}",
    ],
    "annotation": [
        "highlight the {quantity}",
        "label the {quantity}",
        "mark the equilibrium position",
        "point to the {object}",
        "circle the {object}",
        "put an arrow on the {quantity}",
        "underline that",
        "mark where the {quantity} is maximum",
        "label the axes",
        "show the {quantity} vector",
    ],
    "simulation_command": [
        "run the experiment",
        "run the simulation",
        "let us simulate this",
        "start the experiment",
        "simulate the {object} under {concept}",
        "run it and see what happens",
        "let the simulation play out",
        "execute the experiment",
        "run this for ten seconds",
        "simulate what happens to the {quantity}",
    ],
    "comparison": [
        "show the difference between these two cases",
        "compare the two {object}s",
        "put them side by side",
        "show both together",
        "how does this compare with {concept}",
        "show the same thing with a larger {quantity}",
        "compare it with the previous case",
        "show me both at once",
        "what if we had two {object}s instead",
        "place the two {object}s next to each other",
    ],
    "explanation": [
        "why does this happen",
        "why is the {quantity} decreasing",
        "explain why the {object} behaves this way",
        "what causes {concept}",
        "why does the {quantity} depend on the {object}",
        "can you explain that again",
        "how does {concept} actually work",
        "what is the reason for this",
        "why is the {quantity} zero here",
        "explain the relationship between the {quantity} and {concept}",
    ],
}

# Surface variation a real teacher produces. Applied at generation time, never at eval time only,
# so the model does not learn that punctuation predicts the label.
PREFIX = ["", "", "", "ok ", "right ", "now ", "so ", "alright ", "and ", "please "]
SUFFIX = ["", "", "", "", " please", " for me", " here", " on the board", " for them"]


def fill(template: str) -> str:
    """Expand one template with random slot values."""
    return template.format(
        object=random.choice(OBJECT),
        quantity=random.choice(QUANTITY),
        concept=random.choice(CONCEPT),
        direction=random.choice(DIRECTION),
        speed=random.choice(SPEED),
    )


def surface(text: str) -> str:
    """Add the noise of speech: leading fillers, trailing politeness, casing, stray punctuation."""
    s = random.choice(PREFIX) + text + random.choice(SUFFIX)
    r = random.random()
    if r < 0.12:
        s = s.upper()                      # a transcript that lost its casing
    elif r < 0.22:
        s = s.capitalize()
    if random.random() < 0.25:
        s = s + random.choice([".", "?", "!", "..."])
    return s.strip()


def build(per_template: int = 26):
    """
    Generate rows GROUPED BY TEMPLATE, so the split can keep a template wholly inside one split.

    This is the part that decides whether the eval number is real. If the same template appears in
    train and in test with different slot values, the model can memorise the template and the test
    score measures nothing but that memorisation. Splitting by template forces the test set to be
    sentences whose SHAPE was never seen.
    """
    groups = []  # (label, template_index, [texts])
    for label, templates in TEMPLATES.items():
        for ti, t in enumerate(templates):
            seen = set()
            texts = []
            for _ in range(per_template * 3):     # over-draw, then dedupe
                s = surface(fill(t))
                if s.lower() not in seen:
                    seen.add(s.lower())
                    texts.append(s)
                if len(texts) >= per_template:
                    break
            groups.append((label, ti, texts))
    return groups


def split(groups, dev_frac=0.15, test_frac=0.15):
    """Stratified per label, disjoint by template."""
    train, dev, test = [], [], []
    by_label = {}
    for g in groups:
        by_label.setdefault(g[0], []).append(g)

    for label, gs in by_label.items():
        gs = gs[:]
        random.shuffle(gs)
        n = len(gs)
        n_dev = max(1, int(round(n * dev_frac)))
        n_test = max(1, int(round(n * test_frac)))
        # A label with too few templates cannot give a disjoint split without starving training.
        if n - n_dev - n_test < 1:
            n_dev = n_test = 1
        for g in gs[:n_test]:
            test.extend({"text": t, "label": label} for t in g[2])
        for g in gs[n_test:n_test + n_dev]:
            dev.extend({"text": t, "label": label} for t in g[2])
        for g in gs[n_test + n_dev:]:
            train.extend({"text": t, "label": label} for t in g[2])

    for part in (train, dev, test):
        random.shuffle(part)
    return train, dev, test


def write(name, rows):
    path = os.path.join(OUT, name + ".jsonl")
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    return path


def main():
    os.makedirs(OUT, exist_ok=True)
    groups = build()
    train, dev, test = split(groups)

    # A leak here would silently inflate every number that follows, so check rather than trust.
    train_texts = {r["text"].lower() for r in train}
    overlap = sum(1 for r in test if r["text"].lower() in train_texts)

    for name, rows in (("train", train), ("dev", dev), ("test", test)):
        write(name, rows)
        counts = {}
        for r in rows:
            counts[r["label"]] = counts.get(r["label"], 0) + 1
        print(f"{name:6s} {len(rows):5d}  " + " ".join(f"{k}={v}" for k, v in sorted(counts.items())))

    print(f"\nexact-text overlap train/test: {overlap}")
    print(f"labels: {len(LABELS)}   seed: {SEED}")
    print("NOTE: synthetic seed corpus. Replace with real teacher utterances as they are captured.")


if __name__ == "__main__":
    main()
