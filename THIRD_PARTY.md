# Third-Party Notices and Attribution

This project incorporates architectural concepts, query contracts, language definitions, and interfaces adapted from upstream open-source projects under the MIT License.

---

## codebase-memory-mcp

Portions of Veyra's Code Intelligence subsystem (including repository discovery, file filtering, language classification heuristics, graph tracing protocols, code intelligence queries, and client adapters) are adapted from or interface with `codebase-memory-mcp`.

- **Project:** [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)
- **Copyright:** Copyright (c) 2025 DeusData
- **License:** MIT License

### MIT License Text

```text
MIT License

Copyright (c) 2025 DeusData

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## dsh-memory

The FTS evidence merge deduplication key (`path:note:uri:anchor` cap 32), rolling window with per-step stable push, session attribution on write calls, prompt-safety brace/boundary neutralization, and hook-pipeline audit recorder patterns are adapted from `dsh-memory`.

- **Project:** [dsh-memory](https://github.com/FuRongJun-1999/dsh-memory)
- **Copyright:** Copyright (c) 2026 FuRongJun-1999
- **License:** MIT License

### MIT License Text

```text
MIT License

Copyright (c) 2026 FuRongJun-1999

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## tencentdb-agent-memory

The FTS5 schema v2 pattern (`content_original UNINDEXED` + isolation columns), `buildFtsQuery` with quoted OR-joined phrases, BM25→0-1 calibration via `relevance/(1+relevance)`, `rebuildFtsIndex()`, and Reciprocal Rank Fusion `1/(k+rank+1)` are adapted from `tencentdb-agent-memory`.

- **Project:** [tencentdb-agent-memory](https://github.com/Tencent/TencentDB-Agent-Memory)
- **Copyright:** Copyright (C) 2026 Tencent
- **License:** MIT License

### MIT License Text

```text
MIT License

Copyright (C) 2026 Tencent

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## mnemon

The zero-dependency tokenizer (English split + stopwords + CJK char-bigrams via `flushCJK`), JaccardSimilarity for claim-token overlap, and the importance decay formula `base * log(1+access_count) * 0.5^(days_since_access/half_life) * (1+0.1*min(edges,5))` are adapted from `mnemon`.

- **Project:** [mnemon](https://github.com/mnemon-ai/mnemon)
- **Copyright:** Copyright (c) Mnemon Contributors
- **License:** Apache License 2.0

### Apache License 2.0 Text

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License.

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work, that is intentionally submitted to Licensor for
      inclusion in the Work by the copyright owner or by an individual
      or Legal Entity authorized to submit Contributions.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise dispose of the
      Work, where such license applies only to those patent claims
      licensable by such Contributor that are necessarily infringed by
      their Contribution.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in Source or Object form, with
      or without modifications, and in Source or Object form, provided
      that You meet the following conditions:

      (a) You must give any other recipients of the Work or Derivative
      Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
      stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
      that You distribute, all copyright, patent, trademark, and
      attribution notices from the Source form of the Work, excluding
      those notices that do not pertain to the part of the Derivative
      Works that is modified; and

      (d) If the Work includes a "NOTICE" text file as part of its
      distribution, then any Derivative Works that You distribute must
      include a readable copy of the NOTICE file distributed with the
      Work, excluding those notices that do not pertain to the part of
      the Derivative Works that is modified.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You shall be treated as a Contribution under the terms of this
      License, without any additional terms or conditions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use of the type of
      the Work.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contribution) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, but not limited to, the WARRANTIES OF
      MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
      NONINFRINGEMENT. IN NO EVENT SHALL THE LICENSOR OR CONTRIBUTORS
      BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
      IN AN ACTION OF CONTRACT, TORT, OR OTHERWISE, ARISING FROM,
      OUT OF OR IN CONNECTION WITH THE WORK OR THE USE OR OTHER
      DEALINGS IN THE WORK.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      shall any Contributor be liable to You for damages, including any
      direct, indirect, incidental, special, exemplary, or consequential
      damages (including lost opportunity) arising out of or in connection
      with the Work or the use of or other dealings in the Work.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to accept,
      with or without modification, any warranty or additional liability
      offered by a third party for such Derivative Works. However, in
      doing so, You must act in compliance with the terms and conditions
      of this License and are solely responsible for such acceptance.

   END OF TERMS AND CONDITIONS
```
