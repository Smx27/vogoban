import { Component, OnInit, inject } from "@angular/core";
import { HttpClient } from "@angular/common/http";

@Component({ selector: "app-settings", standalone: true, template: "<p>settings</p>" })
class SettingsComponent implements OnInit {
  private readonly http = inject(HttpClient);
  ngOnInit() {
    this.http.get("/api/settings").subscribe();
  }
}
export { SettingsComponent as SettingsPage };
