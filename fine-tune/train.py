#!/usr/bin/env python3
"""QLoRA fine-tuning for the AAR Generator's local model.

Trains a small instruct model to reproduce the live model's behavior
(chat -> final AAR JSON) using a sharegpt-format JSONL dataset produced by
scripts/generate-dataset.js or the app's "Download dataset" button.

Runs on a GPU: a free Colab T4 works for 7-8B bases; 16GB+ VRAM for 14B.

Setup:
    pip install unsloth "xformers" --no-deps --extra-index-url https://download.pytorch.org/whl/cu121

Usage:
    python fine-tune/train.py --base Qwen/Qwen3-8B --dataset dataset.jsonl --out ./aar-model
    python fine-tune/train.py --base Qwen/Qwen3-14B --dataset dataset.jsonl --epochs 3

Outputs:
    <out>-merged/  merged 16-bit model (for further export)
    <out>-gguf/    GGUF Q4_K_M files, ready for Ollama (see Modelfile.example)

Note: the Unsloth/TRL APIs move fast - if an import or argument changed in the
version you installed, check https://docs.unsloth.ai and adjust accordingly.
"""

import argparse
import json

from datasets import load_dataset
from trl import SFTTrainer
from transformers import TrainingArguments
from unsloth import FastLanguageModel
import torch


def format_example(example, tokenizer):
    """Convert sharegpt {messages: [...]} into a chat-templated text string."""
    msgs = example["messages"]
    text = tokenizer.apply_chat_template(
        msgs, tokenize=False, add_generation_prompt=False
    )
    return {"text": text}


def main():
    ap = argparse.ArgumentParser(description="QLoRA fine-tune the local AAR model")
    ap.add_argument("--base", default="unsloth/Qwen3-8B",
                    help="Base instruct model (HuggingFace id or local path)")
    ap.add_argument("--dataset", required=True, help="sharegpt JSONL dataset")
    ap.add_argument("--out", default="aar-model", help="Output directory prefix")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--rank", type=int, default=16, help="LoRA rank")
    ap.add_argument("--max-seq-len", type=int, default=8192,
                    help="Max tokens per conversation (AAR chats run long)")
    ap.add_argument("--batch-size", type=int, default=2)
    ap.add_argument("--grad-accum", type=int, default=4)
    args = ap.parse_args()

    # --- Load base model in 4-bit ---
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.base,
        max_seq_length=args.max_seq_len,
        dtype=None,          # auto: bf16 if supported, else fp16
        load_in_4bit=True,
    )

    # --- Attach LoRA adapters ---
    model = FastLanguageModel.get_peft_model(
        model,
        r=args.rank,
        lora_alpha=args.rank * 2,
        lora_dropout=0,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"],
        bias="none",
        use_gradient_checkpointing="unsloth",
        use_rslora=True,
        max_seq_length=args.max_seq_len,
        random_state=42,
    )

    # --- Load + format the dataset ---
    dataset = load_dataset("json", data_files=args.dataset, split="train")
    dataset = dataset.map(lambda ex: format_example(ex, tokenizer), num_proc=2)
    dataset = dataset.train_test_split(test_size=0.05, seed=42)
    train_ds, eval_ds = dataset["train"], dataset["test"]
    print(f"train={len(train_ds)} eval={len(eval_ds)} examples")

    # --- Train ---
    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        dataset_text_field="text",
        max_seq_length=args.max_seq_len,
        packing=True,
        args=TrainingArguments(
            per_device_train_batch_size=args.batch_size,
            gradient_accumulation_steps=args.grad_accum,
            warmup_steps=10,
            num_train_epochs=args.epochs,
            learning_rate=2e-4,
            fp16=not torch.cuda.is_bf16_supported(),
            bf16=torch.cuda.is_bf16_supported(),
            logging_steps=1,
            eval_strategy="steps",
            eval_steps=50,
            optim="adamw_8bit",
            weight_decay=0.01,
            lr_scheduler_type="cosine",
            seed=3407,
            output_dir=args.out,
            report_to="none",
        ),
    )
    trainer.train()

    # --- Save merged weights + GGUF for Ollama ---
    model.save_pretrained_merged(args.out + "-merged", tokenizer, save_method="merged_16bit")
    model.save_pretrained_gguf(args.out + "-gguf", tokenizer, quantization_method="q4_k_m")
    print("Done!")
    print("Merged:", args.out + "-merged")
    print("GGUF:  ", args.out + "-gguf")
    print("Next: put the .gguf in fine-tune/ and run:")
    print("  ollama create aar-local -f fine-tune/Modelfile.example")


if __name__ == "__main__":
    main()
