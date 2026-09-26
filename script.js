"use strict"
      let groups = [];
      let students = [];
      let assignments = [];
      let sourceFilename = "";
      let duplicateCount = 0;

      const $ = (s) => document.querySelector(s);
      const esc = (s) =>
        String(s ?? "").replace(
          /[&<>"']/g,
          (c) =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            })[c],
        );

      function parseCSV(text) {
        const out = [];
        let row = [], cell = "", q = false;
        for (let i = 0; i < text.length; i++) {
          const c = text[i];
          if (q) {
            if (c === '"' && text[i + 1] === '"') {
              cell += '"';
              i++;
            } else if (c === '"') {
              q = false;
            } else cell += c;
          } else {
            if (c === '"') q = true;
            else if (c === ",") {
              row.push(cell);
              cell = "";
            } else if (c === "\n") {
              row.push(cell);
              out.push(row);
              row = [];
              cell = "";
            } else if (c !== "\r") cell += c;
          }
        }
        if (cell.length || row.length) {
          row.push(cell);
          out.push(row);
        }
        return out;
      }
      function norm(s) {
        return String(s ?? "").trim().toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ");
      }
      function normTime(s) {
        return norm(s)
          .replace(/\b(est|edt|et)\b/g, "")
          .replace(/\s+/g, "")
          .replace(/:00/g, "")
          .replace(/(am|pm)-(?=\d)/g, "-")
          .trim();
      }
      function findHeader(headers, pred) {
        const i = headers.findIndex((h) => pred(norm(h)));
        return i;
      }
      function affinityList(v) {
        const x = norm(v);
        const a = [];
        if (x.includes("multicultural group")) a.push("Multicultural");
        if (x.includes("lgbtq+ group") || x.includes("lgbtq group"))
          a.push("LGBTQ+");
        return a;
      }
      function readQualtrics(rows) {
        if (rows.length < 2) throw new Error("The CSV appears to be empty.");
        const looksQualtrics = rows[0].some((v) => v === "StartDate") && rows[1].some((v) => v === "Start Date");
        const headers = looksQualtrics ? rows[1] : rows[0];
        const start = looksQualtrics ? 3 : 1;
        const ix = {
          first: findHeader(
            headers,
            (h) => h === "first name" || h.startsWith("first name "),
          ),
          last: findHeader(
            headers,
            (h) => h === "last name" || h.startsWith("last name "),
          ),
          email: findHeader(
            headers,
            (h) => h === "umich email" || h.startsWith("umich email "),
          ),
          cohort: findHeader(
            headers,
            (h) => h === "academic standing" || h.includes("academic standing"),
          ),
          finished: findHeader(headers, (h) => h === "finished"),
          recorded: findHeader(headers, (h) => h === "recorded date"),
          affinity: findHeader(
            headers,
            (h) =>
              h.includes("holding two affinity groups") ||
              h.includes("affinity groups are a space"),
          ),
          Monday: findHeader(headers, (h) =>
            h.includes("available at the following times on mondays"),
          ),
          Tuesday: findHeader(headers, (h) =>
            h.includes("available at the following times on tuesdays"),
          ),
          Wednesday: findHeader(headers, (h) =>
            h.includes("available at the following times on wednesdays"),
          ),
          Thursday: findHeader(headers, (h) =>
            h.includes("available at the following times on thursdays"),
          ),
        };
        const missing = [];
        [
          "first",
          "last",
          "cohort",
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
        ].forEach((k) => {
          if (ix[k] < 0) missing.push(k);
        });
        if (missing.length)
          throw new Error(
            "Could not detect required columns: " +
              missing.join(", ") +
              ". You can still use the app with a Qualtrics export that includes name, academic standing, and Monday-Thursday availability.",
          );
        const raw = [];
        for (let r = start; r < rows.length; r++) {
          const row = rows[r];
          const first = (row[ix.first] || "").trim(), last = (row[ix.last] || "").trim();
          if (!first && !last) continue;
          if (ix.finished >= 0 && /false|0/i.test(row[ix.finished] || ""))
            continue;
          const cohortRaw = (row[ix.cohort] || "").trim();
          const cohort = /undergrad/i.test(cohortRaw)
            ? "Undergraduate"
            : /grad/i.test(cohortRaw)
              ? "Graduate"
              : cohortRaw || "Other";
          raw.push({
            first,
            last,
            name: (first + " " + last).trim(),
            email: ix.email >= 0 ? (row[ix.email] || "").trim() : "",
            cohort,
            affinity:
              ix.affinity >= 0 ? affinityList(row[ix.affinity] || "") : [],
            affinityRaw:
              ix.affinity >= 0 ? (row[ix.affinity] || "").trim() : "",
            availability: {
              Monday: row[ix.Monday] || "",
              Tuesday: row[ix.Tuesday] || "",
              Wednesday: row[ix.Wednesday] || "",
              Thursday: row[ix.Thursday] || "",
            },
            recorded: ix.recorded >= 0 ? row[ix.recorded] || "" : "",
            rowNumber: r + 1,
          });
        }
        // De-duplicate by email when present, otherwise exact name. Keep the later CSV occurrence.
        const m = new Map();
        let dups = 0;
        raw.forEach((s) => {
          const key = s.email ? "e:" + norm(s.email) : "n:" + norm(s.name);
          if (m.has(key)) dups++;
          m.set(key, s);
        });
        duplicateCount = dups;
        return [...m.values()];
      }
      function studentAvailable(s, g) {
        // Affinity groups are open to anyone who explicitly selected that affinity.
        if (g.affinity) {
          return s.affinity.includes(g.affinity);
        }

        // Regular groups must match academic level.
        if (s.cohort !== g.cohort) {
          return false;
        }

        const rawAvailability = String(s.availability[g.day] || "");

        if (
          !rawAvailability ||
          norm(rawAvailability).includes("not available")
        ) {
          return false;
        }

        const groupTime = normTime(g.time);

        const availableTimes = rawAvailability
          .split(/[,;\n]/)
          .map(normTime)
          .filter(Boolean);

        return availableTimes.includes(groupTime);
      }

      // Successive-shortest-path min-cost flow. Small graph; SPFA keeps the implementation self-contained.
      function minCostAssign(studs, grps, target) {
        const N = 1 + studs.length + grps.length + 1 + 1; // source, students, groups, unassigned, sink
        const SRC = 0, stuBase = 1, grpBase = 1 + studs.length, UN = grpBase + grps.length, SNK = UN + 1;
        const adj = Array.from({ length: N }, () => []);

        function edge(u, v, cap, cost, meta) {
          const a = { to: v, rev: adj[v].length, cap, cost, meta }, b = { to: u, rev: adj[u].length, cap: 0, cost: -cost, meta: null };
          adj[u].push(a);
          adj[v].push(b);
        }
        studs.forEach((s, i) => edge(SRC, stuBase + i, 1, 0));
        studs.forEach((s, i) => {
          let any = false;
          grps.forEach((g, j) => {
            if (studentAvailable(s, g)) {
              any = true;
              const requestedAny = s.affinity.length > 0;
              let cost = g.affinity ? 0 : requestedAny ? 50 : 0;
              edge(stuBase + i, grpBase + j, 1, cost, { student: i, group: j });
            }
          });
          edge(stuBase + i, UN, 1, 5000 + (any ? 0 : 100), {
            student: i,
            group: -1,
          });
        });
        // convex slot costs favor an even spread; target affects how sharply cost rises after target
        const maxSlots = Math.max(studs.length, 1);
        grps.forEach((g, j) => {
          for (let k = 1; k <= maxSlots; k++) {
            const base = (2 * k - 1) * 4;
            const over = Math.max(0, k - target);
            const overPenalty = over * over * 5;
            edge(grpBase + j, SNK, 1, base + overPenalty, { slot: k });
          }
        });
        edge(UN, SNK, studs.length, 0);
        let flow = 0,
          cost = 0;
        while (flow < studs.length) {
          const dist = Array(N).fill(Infinity), inq = Array(N).fill(false), pv = Array(N).fill(-1), pe = Array(N).fill(-1);
          const q = [SRC];
          dist[SRC] = 0;
          inq[SRC] = true;
          for (let qi = 0; qi < q.length; qi++) {
            const u = q[qi];
            inq[u] = false;
            for (let ei = 0; ei < adj[u].length; ei++) {
              const e = adj[u][ei];
              if (e.cap <= 0) continue;
              const nd = dist[u] + e.cost;
              if (nd < dist[e.to]) {
                dist[e.to] = nd;
                pv[e.to] = u;
                pe[e.to] = ei;
                if (!inq[e.to]) {
                  inq[e.to] = true;
                  q.push(e.to);
                }
              }
            }
          }
          if (!isFinite(dist[SNK])) break;
          let v = SNK;
          while (v !== SRC) {
            const u = pv[v],  ei = pe[v];
            adj[u][ei].cap--;
            adj[v][adj[u][ei].rev].cap++;
            v = u;
          }
          flow++;
          cost += dist[SNK];
        }
        const result = [];
        studs.forEach((s, i) => {
          let gi = -1;
          for (const e of adj[stuBase + i]) {
            if (e.meta && e.meta.student === i && e.cap === 0) {
              gi = e.meta.group;
              break;
            }
          }
          result.push({ student: s, group: gi >= 0 ? grps[gi] : null });
        });
        return result;
      }

      function affinityText(a) {
        return a.length ? a.join(" + ") : "None";
      }
      function renderGroups() {
        const tb = $("#groupTable tbody");
        tb.innerHTML = "";
        groups.forEach((g, i) => {
          const tr = document.createElement("tr");
          tr.innerHTML = `<td><select data-i="${i}" data-k="day">${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((x) => `<option ${x === g.day ? "selected" : ""}>${x}</option>`).join("")}</select></td>
                          <td><input data-i="${i}" data-k="time" type="text" value="${esc(g.time)}" placeholder="Enter Time"></td>
                          <td><input data-i="${i}" data-k="room" type="text" value="${esc(g.room)}" placeholder="Enter Room"></td>
                          <td><select data-i="${i}" data-k="cohort"><option ${g.cohort === "Undergraduate" ? "selected" : ""}>Undergraduate</option><option ${g.cohort === "Graduate" ? "selected" : ""}>Graduate</option></select></td>
                          <td><select data-i="${i}" data-k="affinity"><option value="" ${!g.affinity ? "selected" : ""}>General</option><option ${g.affinity === "LGBTQ+" ? "selected" : ""}>LGBTQ+</option><option ${g.affinity === "Multicultural" ? "selected" : ""}>Multicultural</option></select></td>
                          <td><input data-i="${i}" data-k="facilitators" type="text" value="${esc(g.facilitators || "")}" placeholder="Enter Facilitators"></td>
                          <td><button class="btn danger small" data-del="${i}">Remove</button></td>`;
          tb.appendChild(tr);
        });
        tb.querySelectorAll("[data-k]").forEach((el) =>
          el.addEventListener("change", (e) => {
            const i = +e.target.dataset.i, k = e.target.dataset.k;
            groups[i][k] = e.target.value;
            clearResults();
          }),
        );
        tb.querySelectorAll("input[data-k]").forEach((el) =>
          el.addEventListener("input", (e) => {
            const i = +e.target.dataset.i, k = e.target.dataset.k;
            groups[i][k] = e.target.value;
            clearResults();
          }),
        );
        tb.querySelectorAll("[data-del]").forEach((el) =>
          el.addEventListener("click", () => {
            groups.splice(+el.dataset.del, 1);
            renderGroups();
            clearResults();
          }),
        );
      }
      function clearResults() {
        assignments = [];
        $("#summaryCard").classList.add("hidden");
        $("#groupsCard").classList.add("hidden");
        $("#peopleCard").classList.add("hidden");
      }
      function loadText(text, filename) {
        try {
          const rows = parseCSV(text);
          students = readQualtrics(rows);
          sourceFilename = filename;
          const u = students.filter((s) => s.cohort === "Undergraduate").length, g = students.filter((s) => s.cohort === "Graduate").length;
          $("#fileStatus").className = "status good";
          $("#fileStatus").textContent =
            `Loaded ${students.length} participant records (${u} undergraduate, ${g} graduate)${duplicateCount ? `; ${duplicateCount} duplicate submission${duplicateCount === 1 ? "" : "s"}` : ""}.`;
          $("#assignBtn").disabled = !students.length;
          $("#clearBtn").disabled = !students.length;
          clearResults();
        } catch (err) {
          students = [];
          $("#fileStatus").className = "status bad";
          $("#fileStatus").textContent = err.message;
          $("#assignBtn").disabled = true;
          $("#clearBtn").disabled = true;
          clearResults();
        }
      }
      function readFile(file) {
        if (!file) return;
        const r = new FileReader();
        r.onload = () => loadText(r.result, file.name);
        r.readAsText(file);
      }
      function csvEscape(v) {
        const s = String(v ?? "");
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }
      function download(name, text, type = "text/csv;charset=utf-8") {
        const b = new Blob([text], { type });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(b);
        a.download = name; document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          URL.revokeObjectURL(a.href);
          a.remove();
        }, 500);
      }
      function assignmentStatus(a) {
        if (!a.group) return "Unassigned - no eligible configured group";
        if (a.student.affinity.length && !a.group.affinity)
          return "Assigned to general group";
        return "Assigned";
      }
      function renderResults() {
        const target = Math.max(1, +$("#target").value || 5);
        assignments = minCostAssign(students, groups, target);

        const un = assignments.filter((a) => !a.group).length;
        const affReq = students.filter((s) => s.affinity.length).length;

        const affPlaced = assignments.filter(
          (a) => a.group && a.group.affinity,
        ).length;

        const gradUn = assignments.filter(
          (a) => a.student.cohort === "Graduate" && !a.group,
        ).length;
        
        $("#stats").innerHTML =
          `<div class="stat"><b>${students.length}</b><span>participants read</span></div><div class="stat"><b>${assignments.length - un}</b><span>assigned</span></div><div class="stat"><b>${affPlaced}/${affReq}</b><span>affinity placements / requests</span></div><div class="stat"><b>${un}</b><span>unassigned</span></div>`;
        $("#summaryText").textContent =
          `Balanced toward ${target} participants per group. Facilitators/existing names are not included in these counts.`;
        const warnings = [];

        if (gradUn)
          warnings.push(
            `${gradUn} graduate participant${gradUn === 1 ? " is" : "s are"} not assigned to a regular group. Graduates who requested an affinity group are eligible for that affinity group; other unassigned graduates will be listed at the bottom of the roster CSV.`,
          );
        const noOptions = assignments.filter(
          (a) =>
            !a.group && !groups.some((g) => studentAvailable(a.student, g)),
        ).length;
        if (noOptions && noOptions !== gradUn)
          warnings.push(
            `${noOptions} participant${noOptions === 1 ? " has" : "s have"} no eligible configured group based on availability/cohort.`,
          );
        if (duplicateCount)
          warnings.push(
            `${duplicateCount} duplicate submission${duplicateCount === 1 ? " was" : "s were"} detected and collapsed, keeping the later row in the CSV.`,
          );
        const interestCounts = {
          "LGBTQ+": students.filter((s) => s.affinity.includes("LGBTQ+"))
            .length,
          Multicultural: students.filter((s) =>
            s.affinity.includes("Multicultural"),
          ).length,
        };
        for (const type of ["LGBTQ+", "Multicultural"]) {
          const hasGroup = groups.some((g) => g.affinity === type);
          if (interestCounts[type] && !hasGroup)
            warnings.push(
              `${interestCounts[type]} participant${interestCounts[type] === 1 ? " requested" : "s requested"} the ${type} affinity group, but no ${type} affinity group is configured.`,
            );
        }
        $("#warnings").innerHTML = warnings.length
          ? warnings
              .map((w) => `<div class="status warn">${esc(w)}</div>`)
              .join("")
          : '<div class="status good">No structural conflicts detected.</div>';

        const counts = new Map(groups.map((g) => [g.id, []]));
        assignments.forEach((a) => {
          if (a.group) counts.get(a.group.id).push(a.student);
        });
        $("#groupCards").innerHTML = groups
          .map((g) => {
            const arr = counts.get(g.id) || [];
            const aff = g.affinity
              ? ` <span class="pill aff">${esc(g.affinity)} affinity</span>`
              : "";
            return `<div class="gcard"><div class="ghead"><div><b>${esc(g.day)} · ${esc(g.time)}</b><div class="small muted">${esc(g.room)} · ${esc(g.affinity ? "All academic levels" : g.cohort)}</div></div><div><span class="pill ${arr.length ? "good" : "warn"}">${arr.length} participant${arr.length === 1 ? "" : "s"}</span>${aff}</div></div>${
              arr.length
                ? `<ol class="roster">${arr
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map(
                      (s) =>
                        `<li>${esc(s.name)}${s.affinity.length ? ` <span class="pill aff">${esc(affinityText(s.affinity))}</span>` : ""}</li>`,
                    )
                    .join("")}</ol>`
                : '<div class="muted small mt-8">No participants assigned.</div>'
            }<div class="fac">Facilitators: ${esc(g.facilitators || "None listed")}</div></div>`;
          })
          .join("");

        const pt = $("#peopleTable tbody");
        pt.innerHTML = "";
        [...assignments]
          .sort((a, b) => a.student.name.localeCompare(b.student.name))
          .forEach((a) => {
            const g = a.group;
            const requested = a.student.affinity.length > 0;
            const affPlaced = !!(g && g.affinity);
            const tr = document.createElement("tr");
            tr.innerHTML = `<td>${esc(a.student.name)}</td><td>${esc(a.student.cohort)}</td><td>${requested ? `<span class="pill aff">${esc(affinityText(a.student.affinity))}</span>` : '<span class="muted">None</span>'}</td><td>${g ? `${esc(g.day)} ${esc(g.time)} · ${esc(g.room)}` : '<span class="pill bad">Unassigned</span>'}</td><td>${affPlaced ? `<span class="pill good">Yes - ${esc(g.affinity)}</span>` : requested ? '<span class="pill warn">No</span>' : "—"}</td><td>${esc(assignmentStatus(a))}</td>`;
            pt.appendChild(tr);
          });
        $("#summaryCard").classList.remove("hidden");
        $("#groupsCard").classList.remove("hidden");
        $("#peopleCard").classList.remove("hidden");
        $("#summaryCard").scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }
      function rostersCSV() {
        const rows = [
          [
            "Day",
            "Time",
            "Room",
            "Cohort",
            "Group type",
            "Name",
            "Email",
            "Affinity",
            "Facilitators",
          ],
        ];

        const by = new Map(groups.map((g) => [g.id, []]));

        assignments.forEach((a) => {
          if (a.group) {
            by.get(a.group.id).push(a.student);
          }
        });

        groups.forEach((g, index) => {
          const arr = by.get(g.id) || [];

          if (!arr.length) {
            rows.push([
              g.day,
              g.time,
              g.room,
              g.affinity ? "All academic levels" : g.cohort,
              g.affinity || "General",
              "",
              "",
              "",
              g.facilitators || "",
            ]);
          } else {
            arr
              .sort((a, b) => a.name.localeCompare(b.name))
              .forEach((s) => {
                rows.push([
                  g.day,
                  g.time,
                  g.room,
                  g.affinity ? "All academic levels" : g.cohort,
                  g.affinity || "General",
                  s.name,
                  s.email,
                  affinityText(s.affinity),
                  g.facilitators || "",
                ]);
              });
          }

          // blank row between groups
          if (index < groups.length - 1) {
            rows.push(["", "", "", "", "", "", "", "", ""]);
          }
        });

        // Keep graduate students who were not placed in an affinity group
        // visible at the bottom of the roster export.
        const unassignedGrads = assignments
          .filter((a) => a.student.cohort === "Graduate" && !a.group)
          .map((a) => a.student)
          .sort((a, b) => a.name.localeCompare(b.name));

        if (unassignedGrads.length) {
          rows.push(["", "", "", "", "", "", "", "", ""]);

          unassignedGrads.forEach((s) => {
            rows.push([
              "",
              "",
              "",
              "Graduate",
              s.affinity.length
                ? "Affinity requested - not placed"
                : "Graduate - not assigned",
              s.name,
              s.email,
              affinityText(s.affinity),
              "",
            ]);
          });
        }

        return rows
          .map((r) => r.map(csvEscape).join(","))
          .join("\r\n");
      }

      $("#file").addEventListener("change", (e) => readFile(e.target.files[0]));
      const drop = $("#drop");
      ["dragenter", "dragover"].forEach((ev) =>
        drop.addEventListener(ev, (e) => {
          e.preventDefault();
          drop.classList.add("drag");
        }),
      );
      ["dragleave", "drop"].forEach((ev) =>
        drop.addEventListener(ev, (e) => {
          e.preventDefault();
          drop.classList.remove("drag");
        }),
      );
      drop.addEventListener("drop", (e) => readFile(e.dataTransfer.files[0]));
      $("#assignBtn").addEventListener("click", renderResults);
      $("#clearBtn").addEventListener("click", () => {
        students = [];
        assignments = [];
        sourceFilename = "";
        duplicateCount = 0;
        $("#file").value = "";
        $("#fileStatus").className = "status";
        $("#fileStatus").textContent = "No participant file loaded.";
        $("#assignBtn").disabled = true;
        $("#clearBtn").disabled = true;
        clearResults();
      });
      $("#addGroup").addEventListener("click", () => {
        groups.push({
          id: "g" + Date.now(),
          day: "Monday",
          time: "",
          room: "",
          cohort: "Undergraduate",
          affinity: "",
          facilitators: "",
        });
        renderGroups();
        clearResults();
      });
      $("#downloadRosters").addEventListener("click", () =>
        download("wsn_group_rosters.csv", rostersCSV()),
      );
      $("#target").addEventListener("change", clearResults);
      renderGroups();
