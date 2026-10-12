import { Component, OnInit, inject } from "@angular/core";
import { HttpClient } from "@angular/common/http";

@Component({ selector: "app-reports", standalone: true, template: "<p>reports</p>" })
export default class ReportsComponent implements OnInit {
  private readonly http = inject(HttpClient);
  ngOnInit() {
    this.http.get("/api/reports").subscribe();
  }
}
