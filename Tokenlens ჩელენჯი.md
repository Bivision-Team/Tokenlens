# TokenLens v0.3 — Red Team

Oct 7, 2026 · @Bivision

TokenLens v0.3 მუშაობს და API-ის ჯამებს ზუსტად ითვლის, მაგრამ კატეგორიებით ხსნის გადამუშავებული input-ის მხოლოდ 3.7%-ს. მიზანია, გუნდში ყველამ იცოდეს, რაში იხარჯება ტოკენი და როგორ დაზოგოს; ამისთვის ქვემოთ შვიდი ჩელენჯია პრიორიტეტის მიხედვით.

შემოწმდა commit `66fd2fb` (2026-10-05): წაკითხულია ყველა 19 ფაილი, გაშვებულია ტესტები და ერთი რეალური სესია ერთი subagent-ით (Node 22.22.0, Linux).

## რა მუშაობს კარგად

საფუძველი სანდოა, ამიტომ ქვემოთ ჩამოთვლილი ცვლილებები მასზე დაშენებაა და არა გადაწერა.

- 12 ტესტიდან 12 გადის (`node --test`).
- `exact` / `estimated` / `heuristic` მარკირება თანმიმდევრულია; usage დედუპლიცირდება request ID-ით.
- Privacy დაპირება სრულდება: hook-ის ჩანაწერში მხოლოდ ზომები და HMAC-ია, კონტენტი არ ინახება.
- `--include-agents` სწორად აჯამებს მთავარ სესიასა და subagent-ებს და აჩვენებს თითოეულის წილს.

## მთავარი ხარვეზი: ახსნილია ხარჯის 3.7%

სატესტო სესიაზე კატეგორიებმა ახსნა 78.4k ტოკენი 2.13M-დან. დანარჩენი 96% ანგარიშში არცერთ კატეგორიას არ ეკუთვნის.

| მაჩვენებელი (`current --include-agents`) | ტოკენი |
| --- | --- |
| Combined processed input \[exact\] | 2.13M |
| აქედან cache reads | 1.91M |
| აქედან cache creation | 218.1k |
| აქედან fresh input | 70 |
| Combined attributed messages \[estimated\] | 78.4k |
| მთავარი სესიის ბოლო მოთხოვნის input | 212.5k |
| მთავარი სესიის attributed messages | 51.3k |

მიზეზი ორია.

1. **კონტენტი ერთხელ ითვლება, მუშავდება ბევრჯერ.** 12-მოთხოვნიანი სესიის მე-3 მოთხოვნაზე წაკითხული 5k-იანი ფაილი მომდევნო 9 მოთხოვნაშიც კონტექსტშია, ანუ ჯამში \~45k ჯდება. ანგარიში აჩვენებს 5k-ს.
2. **ფიქსირებული ტვირთი არ ჩანს.** System prompt, tool-ების სქემები, CLAUDE.md და skills ყოველ მოთხოვნას მიჰყვება. აქ ეს იყო დაახლოებით 161k მოთხოვნაზე (212.5k − 51.3k), და არცერთ კატეგორიაში არ მოხვდა.

სატესტო სესია ღრუბლოვანი იყო, ჩვეულებრივზე დიდი system prompt-ით, ამიტომ CLI-ზე წილი სხვა იქნება. გადასამოწმებლად: გაუშვი `current --include-agents` სამ რეალურ სესიაზე და გაყავი attributed messages processed input-ზე.

## ჩელენჯები პრიორიტეტით

პირველი ორი განსაზღვრავს, შეიძლება თუ არა ანგარიშის გუნდში გამოყენება; დანარჩენი მათ შემდეგ მოდის.

| # | ჩელენჯი | მტკიცებულება | მზად არის, როცა |
| --- | --- | --- | --- |
| 1 | კატეგორიებმა ახსნან მთელი ხარჯი | ახსნილია 3.7% | ანგარიში ბეჭდავს ახსნილ წილს; სამ რეალურ სესიაზე ის 90%+ია; ნაშთი ცალკე ხაზად ჩანს |
| 2 | აგენტი სახელით და არა ID-ით | ანგარიშში წერია `a8dda14b…`; `agent_type` hook-ში იწერება, მაგრამ არ იკითხება; `aggregate` subagent-ებს არ ითვლის | Usage breakdown აჩვენებს agent type-ს; `aggregate` აჯამებს subagent-ებს type-ის მიხედვით |
| 3 | გუნდის ერთიანი სურათი | ყველა ანგარიში ერთ მანქანაზე რჩება | ერთი ბრძანება აერთიანებს რამდენიმე `aggregate --json` ფაილს ცხრილად: ადამიანი, პროექტი, აგენტი, ტოკენი |
| 4 | რიცხვიდან მოქმედებამდე | ანგარიში რჩევას არ იძლევა; განმეორებადი ციკლი (ერთი ბრძანება N-ჯერ) არ იძებნება | 3–5 წესი, თითო კონკრეტული ზღვრითა და მოქმედებით (მაგ. ფიქსირებული ტვირთი 60%+ → შეამცირე CLAUDE.md და MCP სერვერები) |
| 5 | ღირებულებით შეწონვა | cache read და fresh input თანაბრად იჯამება, თუმცა API ფასებში cache read დაახლოებით 10-ჯერ იაფია | დამატებითი ხაზი API-equivalent წონებით, მონიშნული `[estimated]` |
| 6 | Hook-ების გამარტივება | 12 hook; \~72ms თითო გაშვება; თითო ფაილი event-ზე, წაშლის გარეშე; ანგარიში კითხულობს მხოლოდ active-session მაჩვენებელს | რჩება მხოლოდ ის hook-ები, რომლების მონაცემსაც ანგარიში იყენებს, ან spool-ს აქვს ვადა |
| 7 | წვრილმანები | `npm test` ვარდება Node 22.22-ზე (`--test-isolation=none`); `/tokenlens:report`-ს აქვს `allowed-tools: Bash(node *)` | `npm test` გადის Node 20-სა და 22-ზე; allowed-tools შეზღუდულია `tokenlens.js`-ის გზაზე |

## ჩელენჯი 1-ის სპეციფიკაცია

თითო კონტენტის ბლოკი უნდა გამრავლდეს იმ მოთხოვნების რაოდენობაზე, რომლებშიც კონტექსტში იყო, და ფიქსირებული ტვირთი ცალკე კატეგორიად გამოვიდეს. ამისთვის საჭირო მონაცემი ტრანსკრიპტში უკვე არის.

```text
Cumulative attribution, per transcript (main and each subagent)

r1..rN = unique successful requests in order (dedupe by requestId)
in_k   = input_tokens + cache_read_input_tokens + cache_creation_input_tokens of rk

1. Fixed overhead
   baseline    = in_1 - est_tokens(messages present at r1)
   fixed_total = baseline * N
   Report as category "Fixed overhead (system prompt, tools, memory files)".

2. Exposure per content block b
   first(b)    = index of the first request that has b in context
   last(b)     = index of the last request before compaction drops b (else N)
   exposure(b) = last(b) - first(b) + 1
   weighted(b) = est_tokens(b) * exposure(b)
   Sum weighted(b) into the existing categories (Read, Bash, Search, MCP, ...).

3. Coverage
   explained    = fixed_total + sum(weighted)
   coverage     = explained / sum(in_k)
   unattributed = sum(in_k) - explained      # print it, even when negative

4. Output
   Keep today's numbers as a "unique" column, add "cumulative" beside it,
   and print coverage % under the totals.
```

`baseline` მიახლოებითია: სესიის შუაში ჩატვირთული tool-ების სქემები მას ზრდის. ამიტომ `unattributed` ხაზი აუცილებლად უნდა დაიბეჭდოს და არ უნდა გადანაწილდეს სხვა კატეგორიებზე.

## რა არ შემოწმებულა

ეს ოთხი კითხვა ღიაა და თქვენს მანქანებზე გაზომვას საჭიროებს.

- **ახსნილი წილი CLI-ზე.** 3.7% ერთ ღრუბლოვან სესიაზეა გაზომილი.
- **Hook-ის დაყოვნება Windows-ზე.** 72ms გაზომილია Linux-ზე, 20 გაშვების საშუალოდ.
- **ქართული ტექსტის შეფასება.** `estimateTokens` იყენებს `bytes / 3.6`-ს; ქართული სიმბოლო UTF-8-ში 3 ბაიტია, ამიტომ ფორმულა ქართულ prompt-ებზე შეიძლება სცდებოდეს. შესადარებელია exact usage-თან.
- **როგორ წონის subscription-ის ლიმიტი cache read-ს.** ეს საჯაროდ განვითარებული არ არის, ამიტომ ჩელენჯი 5 მხოლოდ API ფასების ეკვივალენტს აჩვენებს და არა ლიმიტის რეალურ ხარჯს.

## სად ვისესხოთ იდეები

სამი ღია ინსტრუმენტი იმავე ტრანსკრიპტებს კითხულობს და ჩელენჯ 4-ს უკვე ფარავს; წაკითხულია მხოლოდ მათი README, კოდი არა.

| წყარო | რა აქვს |
| --- | --- |
| [kuzenishh/budget](https://github.com/kuzenishh/budget) | მრავალჯერ წაკითხული ფაილები და სავარაუდო retry loop-ები, tool-ების მიხედვით |
| [keithmackay/tokentamer](https://github.com/keithmackay/tokentamer) | waste-ის ათი ტიპი (redundant reads, duplicated work, context pollution) და `--fix` რეჟიმი |
| [li195111/claude-token-analyzer](https://github.com/li195111/claude-token-analyzer) | ექვსი ანომალიის ტიპი severity-ით, მათ შორის დაბალი cache hit rate |
| [Claude Code: Manage costs](https://code.claude.com/docs/en/costs) | `/usage`: წილები skills, subagents, plugins და MCP სერვერების მიხედვით; behavior flags (long context, cache misses) 10%+ ხარჯზე |
| [Bivision-Team/Tokenlens](https://github.com/Bivision-Team/Tokenlens) | შემოწმებული კოდი, commit `66fd2fb` |
